import { cn } from '@/lib/utils'
const logoUrl = '/logo.png'

/**
 * Brand mark: coati avatar + wordmark.
 * Wordmark = "castor" in bold Geist (tight tracking) + "kit" in the brand gradient, so it follows the accent color.
 * The text sits in the last child div: the collapsed sidebar hides it with [&>div:last-child]:hidden.
 */
export default function BrandMark({ className, imageClassName, showText = true, subtitle }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <img
        src={logoUrl}
        alt={showText ? '' : 'Coati'}
        width={32}
        height={32}
        className={cn('size-8 shrink-0 object-contain', imageClassName)}
      />
      {showText ? (
        <div className="flex min-w-0 flex-col">
          <span aria-label="Coati" className="truncate text-[21px] leading-none font-bold tracking-[-0.04em]">
            Coati
          </span>
          {subtitle ? <span className="text-muted-foreground mt-1 truncate text-[11px]">{subtitle}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
