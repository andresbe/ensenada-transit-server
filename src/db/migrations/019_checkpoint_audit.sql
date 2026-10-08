BEGIN;
-- Keep audit writes database-owned, as with routes, stops and fleet mutations.
CREATE TRIGGER audit_route_checkpoints
AFTER INSERT OR UPDATE OR DELETE ON route_checkpoints
FOR EACH ROW EXECUTE FUNCTION et_audit_mutation();
COMMIT;
