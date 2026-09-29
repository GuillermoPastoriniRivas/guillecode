import { createOpencodeClient } from "@opencode-ai/sdk/client";
const c = createOpencodeClient({baseUrl:"http://localhost:4096", headers:{Authorization:"Basic " + Buffer.from("opencode:05733b87-a254-454e-80b1-92483d2e5441").toString("base64")}});
const events = await c.event.subscribe();
const s = await c.session.create({body:{title:"test-diff-e2e-2"}});
const id = s.data.id;
console.log("sesion:", id);
await c.session.promptAsync({path:{id}, body:{model:{providerID:"opencode-go", modelID:"glm-5.3-flash"}, parts:[{type:"text", text:"Crea el archivo guillecode-test.txt en la raiz del proyecto con una linea que diga hola. Nada mas."}]}});
const it = events.stream[Symbol.asyncIterator]();
const t0 = Date.now();
while (Date.now() - t0 < 75000) {
  const remaining = 75000 - (Date.now() - t0);
  const ev = await Promise.race([
    it.next(),
    new Promise(r => setTimeout(() => r({timeout:true}), remaining)),
  ]);
  if (ev.timeout || ev.done) break;
  const e = ev.value;
  if (!e || !e.type) continue;
  if (e.type.startsWith("session.") || e.type.startsWith("permission") || e.type.includes("error")) {
    console.log(Date.now()-t0, e.type, JSON.stringify(e.properties).slice(0, 160));
  }
  if (e.type === "session.idle" && e.properties.sessionID === id) break;
}
const d = await c.session.diff({path:{id}});
console.log("diff:", JSON.stringify((d.data??[]).map(f => ({file:f.file, a:f.additions, dl:f.deletions}))));
const msgs = await c.session.messages({path:{id}});
console.log("mensajes:", (msgs.data??[]).length);
for (const m of (msgs.data??[])) {
  console.log(m.info.role, "error:", JSON.stringify(m.info.error ?? null).slice(0,120));
  for (const p of m.parts) if (p.type === "tool") console.log("  tool:", p.tool, p.state?.status);
}
await c.session.abort({path:{id}}).catch(()=>{});
await c.session.delete({path:{id}});
console.log("sesion eliminada");
