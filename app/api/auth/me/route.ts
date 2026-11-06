import { currentUser } from "../../../../lib/auth";
import { withJsonErrors } from "../../../../lib/api-json";

export async function GET(request:Request){
 return withJsonErrors(async()=>{
  const user=await currentUser(request);
  return user?Response.json({user}):Response.json({error:"未登录"},{status:401});
 },"暂时无法核对登录状态，请稍后重试");
}
