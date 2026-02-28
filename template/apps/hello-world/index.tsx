// Hello World — demo app for Adiabatic OS
// Shows the basic pattern: UI component + backend function

// UI component — rendered inside MDX pages via <HelloWorld />
export function HelloWorld({ name = "World" }: { name?: string }) {
  return (
    <div style={{ padding: "1rem", border: "1px solid #ccc", borderRadius: "8px" }}>
      <h3>Hello, {name}!</h3>
      <p>This component is rendered from the hello-world app.</p>
    </div>
  );
}

// Backend function — runs in sandbox, receives system API
export async function onSchedule(system: {
  query: (sql: string, params?: unknown[]) => unknown[];
  write: (sql: string, params?: unknown[]) => void;
}) {
  // Create table if not exists
  system.write(
    "CREATE TABLE IF NOT EXISTS greetings (id TEXT PRIMARY KEY, message TEXT, created_at INTEGER)"
  );

  // Insert a greeting
  const id = crypto.randomUUID();
  system.write(
    "INSERT INTO greetings (id, message, created_at) VALUES (?, ?, ?)",
    [id, "Hello from hello-world app!", Date.now()]
  );
}
