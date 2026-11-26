-- Grant the new accounting.mapping.write permission to every existing role that can already write journals.
-- Additive and idempotent. Not applied to any live DB without the owner's go-ahead.
INSERT INTO role_permissions (role_id, permission_code)
SELECT DISTINCT role_id, 'accounting.mapping.write'
FROM role_permissions
WHERE permission_code = 'accounting.journals.write'
ON CONFLICT DO NOTHING;
