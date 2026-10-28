// Aliases are supplied by source code, never by request data.
export const visibleRouteSql = (alias: string) => `${alias}.active AND ${alias}.visible_in_app AND (${alias}.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines visible_line WHERE visible_line.id=${alias}.transport_line_id AND visible_line.active))`;

// Also hide inconsistent historical rows until an administrator repairs their ownership.
export const validAlertTargetSql = (alias: string) => `
  (${alias}.route_id IS NULL OR EXISTS(SELECT 1 FROM routes alert_route WHERE alert_route.id=${alias}.route_id
    AND alert_route.transport_line_id IS NOT DISTINCT FROM ${alias}.transport_line_id AND ${visibleRouteSql("alert_route")}))
  AND (${alias}.stop_id IS NULL OR EXISTS(SELECT 1 FROM stops alert_stop
    WHERE alert_stop.id=${alias}.stop_id AND alert_stop.route_id=${alias}.route_id))`;
