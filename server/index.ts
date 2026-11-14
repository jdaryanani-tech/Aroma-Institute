import { runStartupWithDiagnostics } from "./startup-diagnostics";

void runStartupWithDiagnostics(() => import("./application"));
