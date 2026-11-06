export type ProductDatabaseFilter='all'|'stocked'|'empty'|'inactive';
type ProductRecord={product:string;sku:string;customerName:string;quantity:number;boxes:number;archived?:boolean};
export function productDatabaseStatus(product:ProductRecord):Exclude<ProductDatabaseFilter,'all'>{
 return product.archived?'inactive':product.quantity>0||product.boxes>0?'stocked':'empty';
}
const normalized=(value:string)=>value.normalize('NFKC').trim().toLocaleLowerCase();
export function filterProductDatabase<T extends ProductRecord>(products:readonly T[],status:ProductDatabaseFilter,owner:string,query:string):T[]{
 const search=normalized(query);
 return products.filter(p=>(status==='all'?!p.archived:productDatabaseStatus(p)===status)&&(!owner||p.customerName===owner)&&normalized([p.product,p.sku,p.customerName].join(' ')).includes(search));
}
