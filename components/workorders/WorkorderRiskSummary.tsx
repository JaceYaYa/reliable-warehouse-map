import type {workorderRisks,WorkDocument} from '../../lib/workorders/model';

export function WorkorderRiskSummary({risks,currentDocument}:{risks:ReturnType<typeof workorderRisks>;currentDocument:WorkDocument|null}){
 const hints=[...new Set([...risks.unresolved,...risks.issues,...risks.warnings])];
 const rows=currentDocument?.rows||[],missingLocations=rows.filter(row=>!row.locations.length).length,missingPacking=rows.filter(row=>!row.boxes||!row.perCarton).length;
 const overview=[missingLocations&&`${missingLocations} 行库位未选`,missingPacking&&`${missingPacking} 行装箱规格待填`,risks.unresolved.length&&`${risks.unresolved.length} 项来源冲突`,`${risks.issues.length} 项需补充或修正`,risks.warnings.length&&`${risks.warnings.length} 项提醒`].filter(Boolean).join('；');
 return <div className="wo-warning wo-risk-summary"><b>核对提示{hints.length>5&&` · 共 ${hints.length} 项`}</b>{risks.held&&<p className="wo-held"><strong>来源要求暂停出库，暂不能下达。</strong></p>}{hints.length>5?<><p>{overview}</p><details><summary>展开全部核对提示（{hints.length} 项）</summary>{hints.map((hint,index)=><p key={index}>{hint}</p>)}</details></>:hints.length?hints.map((hint,index)=><p key={index}>{hint}</p>):<p>当前结构检查通过，仍需人工核对原资料和最终正文。</p>}</div>;
}
