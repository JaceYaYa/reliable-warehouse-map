import type { SyncStats } from "../lib/warehouse-sync";

export function SyncUsage({ stats }: { stats: SyncStats | null }) {
  if (!stats) return null;
  return <details className="sync-usage">
    <summary>同步用量 · 本页已发 {stats.requests} 次请求</summary>
    <p>仅统计当前页面本次打开期间，不是全仓或平台账单。关闭页面或重新登录后重新计数。</p>
    <dl>
      <div><dt>同步请求（实测）</dt><dd>{stats.requests} 次 · 成功 {stats.succeeded} · 失败 {stats.failed}</dd></div>
      <div><dt>未下载完整数据 / 数据块更新（实测）</dt><dd>{stats.unchanged} 次 / {stats.snapshots} 个</dd></div>
      <div><dt>数据库行读取 / 写入（实测样本）</dt><dd>{stats.measuredResponses ? `${stats.rowsRead} / ${stats.rowsWritten}` : "未获取"}</dd></div>
      <div><dt>数据库统计范围</dt><dd>{stats.measuredResponses} 个有效响应的同步数据查询，不含登录校验、写入操作及其他页面；中断或失败请求可能未计入。</dd></div>
      <div><dt>原方式同等前台时长（估算）</dt><dd>约 {3 + Math.floor(stats.visibleMs / 12000) * 3} 次请求（每 12 秒 3 次）</dd></div>
      <div><dt>平台总请求 / 数据库总读写 / CPU / 剩余额度</dt><dd>未获取</dd></div>
      <div><dt>实际费用 / 估算费用</dt><dd>未获取 / 未计算（没有套餐和计费依据）</dd></div>
    </dl>
  </details>;
}
