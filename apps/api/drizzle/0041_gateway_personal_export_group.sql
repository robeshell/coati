-- Separate personal exports from admin-wide usage without changing existing grants.
-- An empty install remains seed-free for legacy import.
UPDATE menus AS child SET parent_id = parent.id
FROM menus AS parent
WHERE child.code = 'gateway_my_usage_export'
  AND parent.code = 'gateway_my_usage'
  AND child.parent_id IS DISTINCT FROM parent.id;
