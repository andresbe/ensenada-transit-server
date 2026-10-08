import { query } from "../db";

type PushResult = { status?: string; id?: string; details?: { error?: string } };
async function expoRequest(path: string, body: unknown, fetcher: typeof fetch) {
  const response = await fetcher(`https://exp.host/--/api/v2/push/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(process.env.EXPO_ACCESS_TOKEN
        ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Expo HTTP ${response.status}`);
  return (await response.json()) as { data?: PushResult | Record<string, PushResult> };
}

// Run from a dedicated worker. Tokens and payloads are never written to logs.
export async function deliverPublishedAlerts(fetcher: typeof fetch = fetch) {
  await query(`INSERT INTO notification_deliveries(user_id,device_id,alert_id)
    SELECT DISTINCT d.user_id,d.id,a.id FROM passenger_devices d JOIN user_preferences p ON p.user_id=d.user_id
    JOIN notification_subscriptions s ON s.user_id=d.user_id JOIN alerts a ON a.route_id=s.route_id OR (a.route_id IS NULL AND (a.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM routes sr WHERE sr.id=s.route_id AND sr.transport_line_id=a.transport_line_id)))
    WHERE d.active AND p.push_notifications_enabled AND p.favorite_route_alerts AND a.published AND (a.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines l WHERE l.id=a.transport_line_id AND l.active)) AND a.starts_at<=NOW() AND a.expires_at>NOW()
    AND COALESCE(a.published_at,a.created_at)>=s.created_at ON CONFLICT DO NOTHING`);
  // A lease allows recovery after worker restarts. Delivery is at least once.
  const pending = await query(`WITH candidates AS (
    SELECT n.id FROM notification_deliveries n WHERE n.status IN ('pending','sending') AND n.next_attempt_at<=NOW()
    ORDER BY n.next_attempt_at LIMIT 25 FOR UPDATE SKIP LOCKED
  ) UPDATE notification_deliveries n SET status='sending',next_attempt_at=NOW()+INTERVAL '10 minutes',attempts=attempts+1
    FROM candidates c WHERE n.id=c.id RETURNING n.*`);
  for (const job of pending.rows) {
    const current = await query(
      `SELECT d.token,a.id AS alert_id,a.route_id,
      CASE WHEN p.language='en' THEN COALESCE(a.title_en,a.title_es) ELSE a.title_es END AS title,
      CASE WHEN p.language='en' THEN COALESCE(a.description_en,a.description_es) ELSE a.description_es END AS body
      FROM passenger_devices d JOIN user_preferences p ON p.user_id=d.user_id JOIN alerts a ON a.id=$2
      WHERE d.id=$1 AND d.user_id=$3 AND d.active AND p.push_notifications_enabled AND p.favorite_route_alerts
      AND a.published AND (a.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines l WHERE l.id=a.transport_line_id AND l.active)) AND a.starts_at<=NOW() AND a.expires_at>NOW()
      AND EXISTS(SELECT 1 FROM notification_subscriptions s WHERE s.user_id=d.user_id AND (s.route_id=a.route_id OR (a.route_id IS NULL AND (a.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM routes sr WHERE sr.id=s.route_id AND sr.transport_line_id=a.transport_line_id)))))`,
      [job.device_id, job.alert_id, job.user_id],
    );
    const item = current.rows[0];
    if (!item) {
      await query("UPDATE notification_deliveries SET status='suppressed' WHERE id=$1", [job.id]);
      continue;
    }
    try {
      const response = await expoRequest(
        "send",
        {
          to: item.token,
          title: item.title,
          body: item.body.slice(0, 1500),
          sound: "default",
          channelId: "transit",
          data: { deliveryId: job.id, alertId: item.alert_id, routeId: item.route_id },
        },
        fetcher,
      );
      const ticket = response.data as PushResult | undefined;
      if (ticket?.status === "ok" && ticket.id) {
        await query(
          "UPDATE notification_deliveries SET status='submitted',ticket_id=$2,next_attempt_at=NOW()+INTERVAL '15 minutes' WHERE id=$1",
          [job.id, ticket.id],
        );
      } else {
        if (ticket?.details?.error === "DeviceNotRegistered")
          await query("UPDATE passenger_devices SET active=FALSE WHERE id=$1", [job.device_id]);
        throw new Error(ticket?.details?.error ?? "Invalid push ticket");
      }
    } catch (error) {
      await query(
        `UPDATE notification_deliveries SET status=$2,last_error=$3,next_attempt_at=NOW()+($4*INTERVAL '1 second') WHERE id=$1`,
        [
          job.id,
          job.attempts >= 5 ? "failed" : "pending",
          error instanceof Error ? error.message.slice(0, 100) : "Push failed",
          Math.min(3600, 60 * 2 ** job.attempts),
        ],
      );
    }
  }
  const submitted = await query(
    "SELECT id,device_id,ticket_id FROM notification_deliveries WHERE status='submitted' AND next_attempt_at<=NOW() LIMIT 100",
  );
  if (!submitted.rows.length) return;
  const response = await expoRequest(
    "getReceipts",
    { ids: submitted.rows.map((r) => r.ticket_id) },
    fetcher,
  );
  const receipts = response.data as Record<string, PushResult> | undefined;
  for (const job of submitted.rows) {
    const receipt = receipts?.[job.ticket_id];
    if (!receipt) {
      await query(
        "UPDATE notification_deliveries SET next_attempt_at=NOW()+INTERVAL '15 minutes',status=CASE WHEN created_at<NOW()-INTERVAL '23 hours' THEN 'failed' ELSE status END WHERE id=$1",
        [job.id],
      );
      continue;
    }
    if (receipt.details?.error === "DeviceNotRegistered")
      await query("UPDATE passenger_devices SET active=FALSE WHERE id=$1", [job.device_id]);
    await query("UPDATE notification_deliveries SET status=$2,last_error=$3 WHERE id=$1", [
      job.id,
      receipt.status === "ok" ? "accepted" : "failed",
      receipt.details?.error ?? null,
    ]);
  }
}
