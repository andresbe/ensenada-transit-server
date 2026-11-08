# Ruptela Eco5 Lite+ ingestion

## Readiness boundary

This repository implements a separate Ruptela TCP receiver and reuses the existing
device registry, assignment history, PostgreSQL outbox, Redis live position, route
matching, direction, ETA and visibility pipeline.

Status at the time of this change:

- **Implemented in code:** framing, CRC-CCITT/Kermit, IMEI lookup, commands 1/68,
  identification commands 15/18, heartbeat command 16, protocol ACK/NACK, durable
  deduplication, Redis publication and existing live APIs.
- **Checked against protocol material:** Ruptela protocol v1.113 examples and the
  independent Traccar implementation/fixtures listed below.
- **Not yet verified:** a raw packet from the physical Eco5-5W-LTE-LA running firmware
  `00.06.82.24`.
- **Not done by this change:** Railway deployment, production migration, TCP proxy
  creation or tracker reconfiguration.

Do not describe the integration as hardware-confirmed until the first physical packet
has been captured, decoded, persisted and acknowledged successfully.

## Architecture

```text
Eco5 Lite+ -> Railway TCP proxy -> ruptela-ingestion:5028
            -> Ruptela decoder -> shared hardware outbox
            -> vehicle_gps_locations -> shared location pipeline
            -> Redis -> existing admin and passenger APIs
```

`ruptela-ingestion` is independent from both the HTTP API and `teltonika-ingestion`.
It must have its own Railway TCP proxy. Never point the Ruptela unit at the Teltonika
proxy.

The receiver does not run migrations. It checks for migration 032 before opening its
listeners and exits if the schema is not ready.

## Protocol behavior

The receiver accepts device-to-server frames with:

```text
packet length (2, big endian)
IMEI (8-byte unsigned integer)
command (1)
payload
CRC16 (2, big endian)
```

The packet length excludes its own 2 bytes and the final CRC. CRC is Kermit/CCITT with
reversed polynomial `0x8408`, initial value zero, calculated from IMEI through payload.
Total frames are limited to 1024 bytes.

Supported device commands:

| Device command | Meaning | Server response |
|---|---|---|
| `1` | Standard records | command `100`, ACK `1` after database commit |
| `68` | Extended records | command `100`, ACK `1` after database commit |
| `15` | Fixed identification | command `115`, ACK `1` |
| `18` | Dynamic identification | command `115`, ACK `1` |
| `16` | Heartbeat | command `116`, ACK `1` |

An unknown IMEI receives identification NACK `00037302b4afa3` only when it sent an
identification packet. Unknown record senders are disconnected without a success ACK.
A valid record packet that cannot be persisted or is malformed receives command `100`
with NACK `0`, then the connection closes. Bad CRC packets and unsupported commands are
never acknowledged as successful.

The parser handles fragmented TCP reads, multiple frames in one read, standard and
extended IO IDs, multiple records, and documented record fragments. Retransmitted
records use a SHA-256 event key over the command and exact record bytes, so a positive
ACK lost on the network does not create duplicate history.

Normalized telemetry includes altitude, speed, heading, satellites, HDOP, ignition,
external voltage and these configured network IO values when present:

| IO ID | Value |
|---|---|
| `27` | GSM/UMTS signal level |
| `29` | External supply voltage in mV |
| `150` | Network operator MCC+MNC |
| `251` or `409` | Ignition |
| `418` | GPRS status |
| `762` | Network technology |
| `763` | Network registration status |

The full IO collection remains in the protected telemetry JSON. IMSI content from
identification is parsed only for packet boundaries and is neither logged nor persisted.

## Database migration

Apply migrations from the normal HTTP backend release process before starting the new
receiver:

```bash
npm run build
npm run migrate
```

Migration `032_ruptela_ingestion.sql` is the only new migration. It:

1. extends the two `vehicle_gps_locations` checks to allow source `RUPTELA`;
2. preserves all existing rows, indexes, primary keys, foreign keys and assignments;
3. adds the protected `tracking_device_packet_diagnostics` table.

Migrations `029_tracking_devices.sql`, `030_vehicle_gps_locations.sql` and
`031_teltonika_ingestion.sql` are not modified.

## Register a test vehicle and device

Create the fleet vehicle through the existing fleet administration flow. Give it a
unique tracking ID such as `TEST-ECO5-001`, assign the intended route, then mark only
that controlled unit as a test vehicle:

```sql
BEGIN;
DO $$
BEGIN
  UPDATE fleet_vehicles
  SET is_test_vehicle = true
  WHERE tracking_id = 'TEST-ECO5-001'
    AND archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST-ECO5-001 does not exist';
  END IF;
END $$;
COMMIT;
```

Register and assign the tracker through the superadmin API. Use the internal UUIDs of
the vehicle and route variant, not their labels:

```bash
curl -X POST "$API_URL/admin/tracking-devices" \
  -H "Authorization: Bearer $SUPERADMIN_JWT" \
  -H "Content-Type: application/json" \
  --data '{
    "provider": "RUPTELA",
    "imei": "REPLACE_WITH_15_DIGIT_IMEI",
    "model": "Eco5 Lite+",
    "firmware_version": "00.06.82.24",
    "status": "active",
    "vehicle_id": "REPLACE_WITH_VEHICLE_UUID",
    "route_variant_id": "REPLACE_WITH_VARIANT_UUID",
    "public_visible": false
  }'
```

The response masks the IMEI to its last four digits. Provider and IMEI are immutable;
retire and register a corrected row instead of silently changing device identity.

Keep `is_test_vehicle=true` and `public_visible=false` during validation. Test vehicles
remain absent from passenger endpoints unless their exact tracking ID is explicitly set
in the API service's temporary `PUBLIC_TEST_VEHICLE_IDS` allowlist. This allowlist is not
required for the authenticated administrative live endpoint.

## Railway service

Create one new service named exactly `ruptela-ingestion` from this repository.

| Railway setting | Exact value |
|---|---|
| Builder | Dockerfile |
| Dockerfile path | `Dockerfile.ruptela` |
| Start command | Dockerfile default: `node dist/ruptela/server.js` |
| Replica count | `1` initially |
| HTTP health port | `8080` (`PORT`) |
| Health path | `/ready` |
| Internal raw TCP port | `5028` (`RUPTELA_TCP_PORT`) |
| TCP proxy target | internal port `5028` |

Clear any inherited API start-command override. Do not run `npm run migrate` in this
service. The Dockerfile does not copy migration SQL, `.env` files, tests or docs into
the runtime image.

Required variables:

```dotenv
NODE_ENV=production
PORT=8080
RUPTELA_TCP_PORT=5028
RAILWAY_DOCKERFILE_PATH=Dockerfile.ruptela
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
LOCATION_TTL_SECONDS=240
RUPTELA_MAX_LIVE_AGE_SECONDS=240
```

`Postgres` and `Redis` are example Railway service names. Select references to the
existing private services and keep the API's current database SSL variables. Do not put
the generated public TCP proxy address in an environment variable: it is the tracker's
destination, not an address to which the server binds.

Recommended initial limits:

```dotenv
RUPTELA_MAX_FRAME_BYTES=1024
RUPTELA_MAX_CONNECTIONS=600
RUPTELA_MAX_IN_FLIGHT=16
RUPTELA_FRAMES_PER_MINUTE=120
RUPTELA_IDLE_TIMEOUT_SECONDS=180
RUPTELA_FRAME_TIMEOUT_SECONDS=30
RUPTELA_OUTBOX_POLL_MS=1000
RUPTELA_ALLOWED_PEERS=
RUPTELA_METRICS_TOKEN=REPLACE_WITH_RANDOM_SECRET
RUPTELA_DIAGNOSTIC_CAPTURE=false
RUPTELA_DIAGNOSTIC_RETENTION_HOURS=168
```

`RUPTELA_ALLOWED_PEERS` checks the immediate socket peer. Leave it empty behind the
Railway TCP proxy unless the actual proxy source ranges have been verified. It cannot be
used as a SIM IP allowlist when Railway hides the original client address.

After a successful deploy, create **Settings -> Networking -> TCP Proxy** for internal
port `5028`. Railway generates the public hostname and public port. Record those exact
generated values for the configurator; the public port will usually not be `5028`.

## Advanced Configurator checklist

Do not overwrite the device until its current configuration has been exported and the
configuration password is known. The existing `64.120.108.24:22749` destination is not
an Ensenada Transit endpoint.

In the Ruptela Advanced Configurator version compatible with this firmware:

1. Back up the complete current configuration.
2. Set SIM/APN to `TM`. Preserve the SIM supplier's username/password values; do not
   invent credentials when they are blank.
3. Set IP1/Port1 to the Railway-generated public TCP hostname and port.
4. Select TCP transport and disable SSL only for this initial compatibility test.
5. Enable the Ruptela extended/v1.1 record protocol when IO IDs above 255 are selected.
6. Configure normal periodic GNSS record collection to 60 seconds and normal record
   transmission to 60 seconds.
7. Preserve priority/event records, offline memory and resend-until-ACK behavior.
8. Enable only the needed IO parameters, including IDs 27, 29, 150, 418, 762 and 763;
   select the ignition parameter shown for this hardware profile.
9. Write the configuration, read it back and verify IP1, Port1, APN, protocol, periods
   and enabled IO values before disconnecting USB.

Configurator labels and parameter IDs can vary by firmware/profile. The steps above are
intentional outcomes, not invented menu paths. Use the vendor configurator/manual for
firmware `00.06.82.24` and retain a before/after configuration export. A locked password
requires the owner/supplier; this backend does not bypass it or remotely reconfigure the
tracker.

## First physical-device verification

1. Confirm migration 032 is applied and `ruptela-ingestion /ready` returns `200`.
2. Confirm the IMEI is registered as `RUPTELA`, active and assigned to the test vehicle
   and route variant.
3. Configure the Railway public TCP hostname/port in IP1/Port1.
4. Power-cycle or use the vendor's explicit connect operation.
5. Watch structured service logs for `connection_accepted`, `device_authorized`,
   `device_identified`, `packet_decoded`, `gps_records_persisted`, `outbox_processed`
   and periodic metrics.
6. Check persisted rows:

```sql
SELECT l.id,l.source,v.tracking_id,l.latitude,l.longitude,l.speed_mps,l.heading,
       l.satellites,l.recorded_at,l.received_at,l.is_valid,
       l.delivery_status,l.delivery_reason,l.telemetry
FROM vehicle_gps_locations l
LEFT JOIN fleet_vehicles v ON v.id=l.vehicle_id
WHERE l.device_id=(SELECT id FROM tracking_devices
                   WHERE imei='REPLACE_WITH_15_DIGIT_IMEI' AND provider='RUPTELA')
ORDER BY l.recorded_at DESC,l.id DESC
LIMIT 20;
```

7. Confirm the newest valid row changes from `pending` to `published`.
8. Confirm the private Redis value contains provider `RUPTELA`, the expected vehicle,
   route variant and nondecreasing timestamp:

```bash
redis-cli -u "$REDIS_URL" GET "bus:location:TEST-ECO5-001"
```

9. Confirm the authenticated administrative endpoint includes it:

```bash
curl "$API_URL/admin/platform/buses/live" \
  -H "Authorization: Bearer $SUPERADMIN_JWT"
```

10. Confirm `/buses/live` and route live endpoints still hide the test unit unless its
    exact ID has been temporarily allowlisted on the API service.

Do not mark hardware verification complete from cellular signal, operator, supply
voltage or a TCP connect alone. A real record must pass CRC, decode, commit, receive ACK,
publish to Redis and appear in the authorized live read.

## Diagnostic capture

Default:

```dotenv
RUPTELA_DIAGNOSTIC_CAPTURE=false
```

If the physical packet differs from the documented layout, enable capture temporarily
on the single receiver replica. Only CRC-valid packets from an already registered active
IMEI can be stored. The table limits raw packets to 1024 bytes, keeps at most 100 rows per
device, and gives each row an expiration time. Packet bytes are never printed to logs.

The superadmin metadata endpoint intentionally omits raw bytes:

```bash
curl "$API_URL/admin/tracking-devices/$DEVICE_ID/packet-diagnostics" \
  -H "Authorization: Bearer $SUPERADMIN_JWT"
```

Retrieve raw bytes only through an approved database maintenance session, then disable
capture and delete the investigated row. Packet content can include location and device
or SIM-related data.

## Troubleshooting

- **No TCP connection:** verify Railway public hostname/port, IP1/Port1 read-back, APN
  `TM`, network registration, GPRS status, data balance and configuration password/write.
- **Immediate identification NACK:** the 15-digit IMEI is absent, inactive or registered
  under another provider.
- **Repeated records/NACKs:** check database readiness, migration 032 and receiver logs.
  The device retains records until a positive command-100 ACK.
- **Rows persist but never publish:** inspect `delivery_reason`; common values are
  `unassigned_vehicle`, `unassigned_route`, `assignment_changed`, `historical`,
  `out_of_order` and `android_session_active`.
- **No position despite network telemetry:** obtain a GNSS fix outdoors; zero satellites
  are retained as invalid diagnostics and never replace the live position.
- **Admin sees it but passengers do not:** this is expected for a test vehicle or a
  device with `public_visible=false`.
- **Old records arrive after reconnect:** they remain in history but the device watermark
  and atomic Redis timestamp comparison prevent them from rewinding the live bus.

## Security notes

IMEI allowlisting is identification, not cryptographic authentication. Initial raw TCP
with SSL disabled is observable/spoofable on hostile networks. Prefer a carrier private
APN/VPN or validated device TLS for a later phase. Do not log IMEI, IMSI, SIM credentials,
full packet bytes or coordinates outside the protected operational stores.

## Protocol references

- [Official Ruptela documentation portal](https://doc.ruptela.com/)
- [Official Eco5 Lite+ data sheet](https://doc.ruptela.com/resources/Storage/tracking-devices-publication/Datasheets/Eco5/EN/EN-Eco5-Lite%2B-datasheet.pdf)
- [Official Ruptela network troubleshooting and IO IDs](https://my.ruptela.com/en/articles/14178996-how-to-troubleshoot-internet-connection-on-devices)
- [Traccar Ruptela decoder](https://github.com/traccar/traccar/blob/master/src/main/java/org/traccar/protocol/RuptelaProtocolDecoder.java)
- [Traccar Ruptela encoder](https://github.com/traccar/traccar/blob/master/src/main/java/org/traccar/protocol/RuptelaProtocolEncoder.java)
- [Ruptela protocol v1.113 mirror](https://pdfcoffee.com/ruptela-protocol-v1113-pdf-free.html)

The binary protocol mirror contains a document authored by Ruptela R&D, but it is hosted
by a third party and is not an authoritative distribution channel. Before a broad rollout,
obtain the current protocol document for Eco5/firmware `00.06.82.24` from Ruptela or the
supplier and compare the first physical capture with this implementation.
