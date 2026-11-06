-- Initialize shelf capacity once, preserving layout, stock and existing overrides.
UPDATE settings SET value=(
 WITH RECURSIVE entries AS (
  SELECT row_number() OVER (ORDER BY CAST(z.key AS INTEGER),CAST(c.key AS INTEGER)) AS n,
   '$['||z.key||'].layout.'||json_quote(c.value)||'.capacityLayers' AS path,
   CASE WHEN instr(c.value,'通道')>0 THEN 1
WHEN upper(c.value) IN ('A1','新A1','A2','新A2','A3','新A3','A4','新A4','A5','新A5','A6','新A6','A7','新A7','A8','新A8','A9','新A9','A10','新A10','A11','新A11','A12','新A12','A13','新A13','A14','新A14','A15','新A15','A16','新A16','A17','新A17','A18','新A18','A19','新A19','A20','新A20','A21','新A21','A22','新A22','A23','新A23','A24','新A24','A25','新A25','A26','新A26','A27','新A27','A28','新A28','A29','新A29','A30','新A30','A31','新A31','A32','新A32','A33','新A33','A34','新A34','A35','新A35','A36','新A36','A37','新A37','A38','新A38','B1','新B1','B2','新B2','B3','新B3','B4','新B4','B5','新B5','B6','新B6','B7','新B7','B8','新B8','B9','新B9','B10','新B10','B11','新B11','B12','新B12','B13','新B13','B14','新B14','B15','新B15','B16','新B16','B17','新B17','B18','新B18','B19','新B19','B20','新B20','B21','新B21','B22','新B22','B23','新B23','B24','新B24','B25','新B25','B26','新B26','B27','新B27','B28','新B28','B29','新B29','B30','新B30','B31','新B31','B32','新B32','C11','新C11','C12','新C12','C13','新C13','C14','新C14','C15','新C15','C16','新C16','C17','新C17','C18','新C18','C19','新C19','C20','新C20','C21','新C21','C22','新C22','C23','新C23','C24','新C24','C25','新C25','C26','新C26','C27','新C27','C28','新C28','C29','新C29','C30','新C30','C31','新C31','C32','新C32','C33','新C33','C34','新C34') THEN 2
WHEN upper(c.value) IN ('D1','新D1','D2','新D2','D3','新D3','D4','新D4','D5','新D5','D6','新D6','D7','新D7','D8','新D8','D9','新D9','D10','新D10','D11','新D11','D12','新D12','D13','新D13','D14','新D14','D15','新D15','D16','新D16','D17','新D17','D18','新D18','D19','新D19','D20','新D20','D21','新D21','D22','新D22','D23','新D23','D24','新D24','D25','新D25','D26','新D26','D27','新D27','D28','新D28','D29','新D29','D30','新D30','D31','新D31','D32','新D32') THEN 3
WHEN upper(c.value) IN ('C1','新C1','C2','新C2','C3','新C3','C4','新C4','C5','新C5','C6','新C6','C7','新C7','C8','新C8','C9','新C9','C10','新C10','E1','新E1','E2','新E2','E3','新E3','E4','新E4','E5','新E5','E6','新E6') THEN 4
ELSE 0 END AS capacity
  FROM json_each(settings.value) z, json_each(z.value,'$.codes') c
  WHERE json_type(settings.value,'$['||z.key||'].layout.'||json_quote(c.value)||'.capacityLayers') IS NULL
 ), patched(n,document) AS (
  SELECT 0,settings.value
  UNION ALL SELECT e.n,json_set(p.document,e.path,e.capacity) FROM patched p JOIN entries e ON e.n=p.n+1
 ) SELECT document FROM patched ORDER BY n DESC LIMIT 1
),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE key='warehouse_zones' AND json_valid(value);
