-- Preserve existing Node device-confirm grants while separating future PAT grants.
INSERT INTO menus (name,code,icon,path,component,sort_order,menu_type,is_visible,is_active)
SELECT '设备登录确认','gateway_device_confirm','IconKey','/agent/device-confirm','gateway/device',10,'menu',false,true
WHERE EXISTS (SELECT 1 FROM menus WHERE code='gateway_keys')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO menus (name,code,parent_id,sort_order,menu_type,is_visible,is_active)
SELECT '确认设备登录','gateway_device_confirm_action',id,1,'button',false,true
FROM menus WHERE code='gateway_device_confirm'
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_menus (role_id,menu_id)
SELECT DISTINCT rm.role_id,new_menu.id FROM role_menus rm
JOIN menus old_menu ON old_menu.id=rm.menu_id AND old_menu.code='gateway_keys_add'
CROSS JOIN menus new_menu
WHERE new_menu.code IN ('gateway_device_confirm','gateway_device_confirm_action')
ON CONFLICT DO NOTHING;
