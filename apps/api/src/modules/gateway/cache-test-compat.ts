import { array, object, type Obj } from './protocol/compat-helpers'
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
const sum = (rows: Obj[], field: string) => rows.reduce((total,row)=>total+(number(row[field])??0),0)
const ratio = (a: number, b: number) => b > 0 ? Math.round(a/b*10000)/10000 : null
/** Legacy response aliases, without changing the native record or fabricating unknown cache counters. */
export function legacyCacheTest(raw: unknown) {
  const row=object(raw), summary=object(row.summary)
  const rounds=array(row.results).map(value=>{
    const round=object(value), read=number(round.cache_read_tokens), miss=number(round.cache_miss_tokens), write=number(round.cache_write_tokens)
    const observed=read===null && miss===null && write===null ? null : (read??0)+(miss??0)+(write??0)
    const input=number(round.input_tokens), complete=read!==null && miss!==null
    return {...round,
      status:round.status==='failed'?'error':round.status,
      prompt_tokens:input, completion_tokens:round.output_tokens??null,
      credential_id:round.upstream_id??null,credential_name:round.upstream_name??null,
      cache_context_tokens:input, cache_observed_tokens:observed,
      cache_status:round.status!=='ok'?'unavailable':round.cache_status,
      cache_coverage:observed!==null && input!==null && (read!==null || miss!==null) ? ratio(observed,input):null,
      cache_ratio_source:complete ? round.cache_miss_source??'reported' : read!==null && input!==null && input>0?'estimated':null,
      ...object(round.legacy),
    }
  })
  const successful=rounds.filter(round=>round.status==='ok') as Obj[]
  const cold=successful[0], warm=successful.slice(1)
  const measurable=(rows:Obj[])=>rows.filter(round=>round.cache_status==='complete')
  const weighted=(rows:Obj[])=>rows.length && measurable(rows).length===rows.length ? ratio(sum(rows,'cache_read_tokens'),sum(rows,'cache_observed_tokens')):null
  const coverage=(rows:Obj[])=>{const known=rows.filter(row=>number(row.cache_coverage)!==null);return ratio(sum(known,'cache_read_tokens'),sum(known,'cache_context_tokens'))}
  const coldLatency=number(cold?.latency_ms),warmLatency=warm.length?sum(warm,'latency_ms')/warm.length:null
  const measuredWarm=measurable(warm), sources=new Set(measurable(successful).map(round=>round.cache_ratio_source).filter(Boolean))
  return {...row,round_details:rounds,summary:{...summary,
    rounds_total:rounds.length, rounds_ok:successful.length,
    cold_latency_ms:coldLatency,warm_avg_latency_ms:warmLatency,
    speedup_x:coldLatency && warmLatency ? Math.round(coldLatency/warmLatency*100)/100:null,
    latency_saved_pct:coldLatency && warmLatency ? Math.round((coldLatency-warmLatency)/coldLatency*1000)/10:null,
    avg_hit_ratio:measuredWarm.length ? ratio(sum(measuredWarm,'hit_ratio'),measuredWarm.length):null,
    warm_hit_ratio:weighted(warm),overall_hit_ratio:weighted(successful),
    warm_cache_coverage:coverage(warm),overall_cache_coverage:coverage(successful),
    cache_data_status:successful.length?summary.cache_status:'unavailable',
    cache_ratio_source:sources.size===1?[...sources][0]:sources.size?'mixed':null,
    cache_observed_tokens:sum(measurable(successful),'cache_observed_tokens'),
    warm_cache_read_tokens:sum(measuredWarm,'cache_read_tokens'),
    warm_cache_write_tokens:sum(measuredWarm,'cache_write_tokens'),
    warm_cache_miss_tokens:sum(measuredWarm,'cache_miss_tokens'),
    warm_cache_observed_tokens:sum(measuredWarm,'cache_observed_tokens'),
    first_round_cache_status:cold?.cache_status??null,
    first_round_cache_hit:Number(cold?.cache_read_tokens??0)>0,
    prompt_tokens:sum(successful,'prompt_tokens'),completion_tokens:sum(successful,'completion_tokens'),
    account_name:successful.find(round=>round.credential_name)?.credential_name??null,
    ...object(summary.legacy),
  }}
}
