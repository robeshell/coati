import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ResourcePage from '@/modules/gateway/components/ResourcePage'
import RouteMigration from '@/modules/gateway/pages/routes/RouteMigration'
import PublicRoutes from '@/modules/gateway/pages/routes/PublicRoutes'
export default function Page() {
  const { t } = useTranslation()
  return (
    <Tabs defaultValue="public">
      <TabsList className="mb-4">
        <TabsTrigger value="public">{t('公开路由')}</TabsTrigger>
        <TabsTrigger value="existing">{t('已有候选配置')}</TabsTrigger>
        <TabsTrigger value="migration">{t('路由迁移')}</TabsTrigger>
      </TabsList>
      <TabsContent value="public">
        <PublicRoutes />
      </TabsContent>
      <TabsContent value="existing">
        <p className="mb-4 text-sm text-muted-foreground">
          {t('已有候选配置继续生效；迁移前请保留原配置。')}
        </p>
        <ResourcePage resource="routes" />
      </TabsContent>
      <TabsContent value="migration">
        <RouteMigration />
      </TabsContent>
    </Tabs>
  )
}
