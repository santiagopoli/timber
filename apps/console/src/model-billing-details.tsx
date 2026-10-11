import {ChevronDownIcon} from 'lucide-react';
import {modelBillingView,type ModelUsage} from './model-billing';
import type {ModelSettings} from '../../../packages/contracts/src/models';

export function ModelBillingDetails({usage,settings}: {usage?:ModelUsage;settings?:ModelSettings}) {
  const view=modelBillingView(usage,settings);
  if(!view.rows.length)return null;
  return <details className="timber-model-billing">
    <summary aria-label="Usage and prices"><span>Usage & prices</span><span className="timber-model-usage-badge">{view.label}</span><ChevronDownIcon aria-hidden="true"/></summary>
    <div className="timber-model-billing-body">
      <table aria-label="Model usage and pricing"><caption>USD / 1M tokens</caption><thead><tr><th scope="col">Route</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Cache</th></tr></thead><tbody>
        {view.rows.map((row,index)=><tr key={`${row.source}-${index}`} data-source={row.source} data-status={row.status}>
          <th scope="row">{row.name}{row.fallback&&<small>Fallback {index}</small>}</th>
          {row.status==='priced'?<><td>{row.input}</td><td>{row.output}</td><td title={row.cached?undefined:'Cached-input price unavailable'}>{row.cached||'—'}</td></>:<td colSpan={3} className="timber-model-rate-status">{row.message}</td>}
        </tr>)}
      </tbody></table>
      {view.note&&<p className="timber-model-billing-note">{view.note}</p>}
    </div>
  </details>;
}
