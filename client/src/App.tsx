import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import DashboardLayout from "./components/DashboardLayout";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";

function Router() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path="/" component={() => <Home />} />
        <Route path="/projects" component={() => <Home defaultView="projects" />} />
        <Route path="/documents" component={() => <Home defaultView="documents" />} />
        <Route path="/review" component={() => <Home defaultView="review" />} />
        <Route path="/research" component={() => <Home defaultView="research" />} />
        <Route path="/reports" component={() => <Home defaultView="reports" />} />
        <Route path="/settings" component={() => <Home defaultView="settings" />} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </DashboardLayout>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster position="top-right" richColors />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
