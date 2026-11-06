const unavailable=()=>Response.json({error:'此功能已停用'},{status:404,headers:{'cache-control':'no-store'}});
export async function GET(){return unavailable();}
export async function POST(){return unavailable();}
