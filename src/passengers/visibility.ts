// Aliases are supplied by source code, never by request data.
export const visibleRouteSql = (alias: string) => `${alias}.active AND ${alias}.visible_in_app AND (${alias}.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines visible_line WHERE visible_line.id=${alias}.transport_line_id AND visible_line.active))`;
