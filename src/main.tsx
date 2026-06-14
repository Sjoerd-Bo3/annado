import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TrayPopup } from "./features/tray/TrayPopup";
import { getWindowLabel } from './backend';

(async () => {
  const label = getWindowLabel();
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  if (label === "tray-popup") {
    root.render(<TrayPopup />);
  } else {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  }
})();
