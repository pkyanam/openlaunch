/** Hidden terminal input shared by the agent and device setup CLIs. */
export async function askSecret(
  prompt: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  environmentName = "OPENLAUNCH_SDK_TOKEN",
): Promise<string> {
  if (!input.isTTY || !output.isTTY)
    throw new Error(
      `Set ${environmentName} when running without an interactive terminal`,
    );
  output.write(prompt);
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  input.setRawMode(true);
  input.resume();
  return new Promise((resolveSecret, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
      if (wasPaused || !input.listenerCount("data")) input.pause();
      output.write("\n");
      error ? reject(error) : resolveSecret(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") return finish(new Error("Input cancelled"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " " && char !== "\u007f") value += char;
        if (value.length > 8192)
          return finish(new Error("Input exceeds its size limit"));
      }
    };
    input.on("data", onData);
  });
}
