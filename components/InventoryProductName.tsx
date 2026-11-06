import {inventorySharedLabels,type InventoryGroup,type InventoryStock} from "../lib/inventory-groups";
export function InventoryProductName({group}:{group:InventoryGroup<InventoryStock>}) {
  const labels=inventorySharedLabels(group);
  return <>{labels.length>0&&<span className="product-attention">（{labels.slice(0,5).join(" / ")}{labels.length>5?` 等${labels.length}项`:""}）</span>}{group.product}</>;
}
