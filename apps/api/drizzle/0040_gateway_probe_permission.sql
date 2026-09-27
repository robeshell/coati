-- Empty install remains seed-free for legacy import; existing roles retain probe rights.
INSERT INTO menus (name,code,icon,path,component,sort_order,menu_type,is_visible,is_active)
SELECT '我的用量','gateway_my_usage','IconFile','/agent/my-usage','gateway/my-usage',11,'menu',false,true
WHERE EXISTS (SELECT 1 FROM menus WHERE code='gateway_keys')
ON CONFLICT(code) DO NOTHING;
--> statement-breakpoint
INSERT INTO menus (name,code,parent_id,sort_order,menu_type,is_visible,is_active)
SELECT '测试模型服务','gateway_upstreams_test',id,4,'button',false,true
FROM menus WHERE code='gateway_upstreams'
ON CONFLICT(code) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_menus (role_id,menu_id)
SELECT DISTINCT rm.role_id,new_menu.id FROM role_menus rm
JOIN menus old_menu ON old_menu.id=rm.menu_id AND old_menu.code='gateway_upstreams_edit'
JOIN menus new_menu ON new_menu.code='gateway_upstreams_test'
ON CONFLICT DO NOTHING;
