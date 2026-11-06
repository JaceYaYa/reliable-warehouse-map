import type {OutboundHistoryRecord} from './outbound-history';

// Owner-requested snapshot, captured from formal records on 2026-11-03.
// These exact existing sources only stop contributing historical-only customer
// options. Names and dates are never blocked; ledgers and billing stay unchanged.
const sources:readonly (readonly [number,number,string])[]=[
 [99,121,'5bf02184-cf8a-4eb4-9205-3a0f37a42b82'],
 [102,121,'4ced8386-ef30-47ab-a890-45990e362ee5'],
 [113,106,'50ea7e4e-5c7f-4399-92ef-f2cc13827455'],
 [151,583,'48981ca6-6972-4e88-967b-12d10f08d750'],
 [173,102,'3e858b98-6962-4974-a502-c73ce7b038cf'],
 [174,252,'6b0c2d6c-5622-4ac1-abfc-c9c6ffec7df0'],
 [175,251,'94bd8a84-f163-4993-bf6c-b1ffac5adc27'],
 [176,250,'85e885a7-b040-45a1-8b94-7d28a684acf3'],
 [179,523,'9d96b151-6776-45da-9d95-93c7d8fa6589'],
 [180,105,'76d43aa3-c1bd-474c-98b0-b7e1ea72c66e'],
 [181,586,'83f8c8ac-ded9-470d-80ea-62a6eb8a1279'],
 [301,880,'f6fd2abf-36dc-433e-8959-d3fd9275d342'],
 [330,878,'9eff5643-59f3-424c-b613-a373bfe9ce0a'],
 [331,879,'e00c2e3a-4058-40dd-a0e3-f7fdcee2002b'],
 [332,880,'b001d448-fdaa-48d6-896c-a9daa55ad1a8'],
 [333,883,'8d8b8b55-a136-4e55-ba03-bae2f1ffebd1'],
 [9,256,'bcd1ad7c-f5dc-4eb3-a858-113c0ea2647a'],
 [10,258,'152cee06-8e9c-45c4-ad86-527aff2b2965'],
 [34,116,'9fb6d62e-0320-4cd6-a876-d50a65cbb577'],
 [35,115,'8e427e01-185d-4e18-8ee1-08ccf6935767'],
 [36,110,'5412477b-5084-4bb4-ab7a-1497c70613de'],
 [37,111,'d7f05c72-dbf3-450d-97dc-61d02de3de77'],
 [38,113,'20407e57-6f78-4a9d-91ad-cdb458f9bd48'],
 [67,143,'da40fbdb-9ee1-4d9a-a8b6-2e2eee60c757'],
 [68,330,'ee3ca804-f18a-4e4f-8da2-760784bf3eef'],
 [69,329,'077d43d0-ae42-4cba-aa49-6629fb33319a'],
 [70,328,'b3e3d0fa-85c6-4467-93b0-2add99c4863a'],
 [75,92,'35912e44-f90d-4f2e-a13f-5d110f60dff6'],
 [127,94,'13bcfba0-31be-4332-9199-7b0e08e79050'],
 [128,93,'5d3fd874-d4ac-4607-8335-927e5dceaf11'],
 [129,91,'6e778d24-6bd4-4700-a74f-240200f7fccb'],
 [130,90,'150ca95e-f486-4c6e-9f2f-8b0c6a538d8e'],
 [131,247,'32aa473c-db99-4f48-a115-700f4856055e'],
 [132,245,'69936263-2757-4e61-aa92-760f64d9625a'],
 [133,248,'3b7e71a2-533e-4420-a821-917d6dae7311'],
 [134,246,'658d05d5-2a0c-4d76-8ab2-4235a18c0617'],
 [135,243,'890578f4-8c66-4639-8d7c-6ce8501adb5d'],
 [136,242,'9c88b687-3b53-4ba4-b40e-69101e67e823'],
 [137,244,'6b0137c2-d1f5-4272-b67e-1cbbe11d8368'],
 [138,262,'b8cddad5-7470-4329-8f62-1af15e1287aa'],
 [139,104,'d4480a71-ceae-482f-ac49-5634a891cc4e'],
 [141,522,'018137db-efd9-472d-a12d-3ea4d0f531eb'],
 [142,520,'f0bf938e-bec3-47f1-968e-bae66fd4817a'],
 [143,521,'53723316-344a-40c7-9e00-e067ba3ce7ac'],
 [144,332,'b4de4a73-67e9-4a3e-8c70-e2ae99a18309'],
 [145,40,'c0f893df-9f19-436b-b506-0b9786c1187c'],
 [146,41,'a8168b84-4dd5-4863-a9da-7bfcf2f0cdd3'],
 [147,42,'9c765503-19ba-4787-a283-b101eec4271d'],
 [148,43,'a96ee8a5-94be-4457-85eb-84a562e72f6d'],
 [183,96,'487e4442-bbbd-45ab-93b1-50f9e1b279c9'],
 [185,639,'013e4835-61b6-4c87-9199-33bc820064cd'],
 [198,514,'38e25c3f-e432-42b2-a229-e3753ab3c086'],
 [249,317,'a1468cbf-9d54-4998-b3b6-be0886859075'],
 [250,314,'ff21dbc4-e267-451a-bb7d-64cb251257bd'],
 [251,316,'c76da13f-302e-4db4-aac9-a092e80aa3f1'],
 [252,315,'765ff290-2c5c-4b29-a01b-0bcd3f65c8ce'],
 [253,292,'0048757a-7410-411a-8541-3b1ab0fcd7e1'],
 [254,291,'21834f46-f20f-4d48-ade6-e61a1ff5756f'],
 [255,289,'d0ae099e-e7e9-406b-af1a-11734d42d914'],
 [256,290,'a5347f51-b99a-4dbe-a12f-f010341edf09'],
 [257,288,'2211b8f5-57fe-473a-bafa-b212d9fde2ff'],
 [269,154,'1c04896e-1b0f-4d0e-a6db-8cb17166b4ba'],
 [270,155,'8c0481c1-c2c0-4a38-95c5-ce9b43bc9325'],
];
type Settlement={id:number;stockId:number;operationId:string};
const settlementKeys=new Set(sources.map(([id,stock,op])=>JSON.stringify([id,stock,op])));
const operationStocks=new Set(sources.map(([,stock,op])=>JSON.stringify([op,'stock:'+stock])));

export function isHistoricalDirectorySnapshotSettlement(row:Settlement){
 return settlementKeys.has(JSON.stringify([row.id,row.stockId,row.operationId]));
}

export function historicalDirectorySnapshotKeys(records:readonly OutboundHistoryRecord[],settlements:readonly Settlement[],direct:readonly {id:unknown;operationId:unknown}[]):Set<string>{
 const archived=new Set(settlements.filter(isHistoricalDirectorySnapshotSettlement).map(row=>'settlement:'+row.id));
 const directOps=new Map(direct.map(row=>['audit:'+row.id,row.operationId]));
 return new Set(records.filter(record=>{
  if(archived.has(record.key))return true;
  const op=record.key.startsWith('audit:')?directOps.get(record.key):record.key.startsWith('goods:')?record.key.slice(6,record.key.lastIndexOf(':')):undefined;
  return typeof op==='string'&&!!record.physicalId&&operationStocks.has(JSON.stringify([op,record.physicalId]));
 }).map(record=>record.key));
}
