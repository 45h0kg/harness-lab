// One request longer than num_ctx, on the raw path: what does the model still see?
const sys = "You are a coding agent. The project codename is HERON-58. Always mention the codename in your reply.";
const lines = []; for (let i = 0; i < 2600; i++) lines.push(`loaded SKU-${String(i).padStart(5, "0")} qty=${(i * 7) % 23} bin=${(i * 13) % 97}`);
const user = "Here is a log:\n" + lines.join("\n") + "\n\nEnd of log. Question: what is the project codename, and what is the last SKU in the log?";
const prompt = `<|im_start|>system\n${sys}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`;
const r = await (await fetch("http://localhost:11434/api/generate", { method: "POST", body: JSON.stringify({ model: "qwen2.5:7b", raw: true, stream: false, prompt, options: { num_ctx: 16384, num_predict: 80, temperature: 0, stop: ["<|im_end|>"] } }) })).json();
const tok = await (await fetch("http://localhost:11434/api/generate", { method: "POST", body: JSON.stringify({ model: "qwen2.5:7b", raw: true, stream: false, prompt: prompt.slice(0, 2000), options: { num_ctx: 16384, num_predict: 1 } }) })).json();
console.log("chars", prompt.length, "prompt_eval_count", r.prompt_eval_count, "\nreply:", r.response);
