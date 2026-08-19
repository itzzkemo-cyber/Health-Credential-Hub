import { createRoot } from "react-dom/client";

import App from "./App";

import "./index.css";

async function bootstrap() {
  if (import.meta.env.MODE === "showcase") {
    const { enableShowcaseApi } = await import("./demo/api");
    enableShowcaseApi();
  }

  createRoot(document.getElementById("root")!).render(<App />);
}

void bootstrap();
