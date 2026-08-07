import OpenAI from "openai";
import "./env";

// Constructed lazily on first use. The OpenAI SDK constructor throws when
// OPENAI_API_KEY is absent, so building the client at module load meant that
// merely IMPORTING this file required the key to be present in the environment.
// That broke two things where the key legitimately isn't available at import
// time: `next build` (page-data collection evaluates every route module) and the
// offline unit tests in CI. The key is only actually needed at the first API
// call, so defer construction until then via a Proxy that keeps the existing
// `openai.embeddings.create(...)` call shape working unchanged.
let _openai: OpenAI | null = null;
function client(): OpenAI {
  return (_openai ??= new OpenAI());
}

export const openai = new Proxy({} as OpenAI, {
  get(_t, prop) {
    const c = client();
    const value = Reflect.get(c, prop);
    return typeof value === "function" ? value.bind(c) : value;
  },
});

export const EMBEDDING_MODEL = "text-embedding-3-small";

export async function embed(text: string): Promise<number[]> {
  const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
  return resp.data[0].embedding;
}
