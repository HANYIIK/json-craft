import ReactDOM from "react-dom/client";
import "./theme/theme";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/jetbrains-mono/400.css";
import { App } from "./app/App";
import "./app/styles.css";
import "./theme/theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
