import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/Home";
import VSL from "@/pages/VSL";
import VSLVideo from "@/pages/VSLVideo";
import CounsellingForm from "@/pages/CounsellingForm";
import Admin from "@/pages/Admin";
import AdminLogin from "@/pages/AdminLogin";
import NotFound from "@/pages/not-found";
import {
  AdminPage as LmsAdminPage,
  CoursePage as LmsCoursePage,
  CourseManagerPage,
  LearnLoginPage,
  PasswordSetupPage,
  StudentDashboardPage,
  TrainerPage,
} from "@/lms-ui";
import { PwaInstallPrompt } from "@/lms-ui/PwaInstallPrompt";

function Router() {
  return (
    <Switch>
      <Route path="/" component={RootLanding} />
      <Route path="/vsl" component={VSL} />
      <Route path="/vsl-video" component={VSLVideo} />
      <Route path="/counselling" component={CounsellingForm} />
      <Route path="/admin/login" component={AdminLogin} />
      <Route path="/admin" component={Admin} />
      <Route path="/learn" component={LearnLoginPage} />
      <Route path="/learn/" component={LearnLoginPage} />
      <Route path="/learn/setup" component={PasswordSetupPage} />
      <Route path="/learn/dashboard" component={StudentDashboardPage} />
      <Route path="/learn/courses/:courseId" component={LmsCoursePage} />
      <Route path="/manage/courses/:courseId" component={CourseManagerPage} />
      <Route path="/trainer" component={TrainerPage} />
      <Route path="/lms-admin" component={LmsAdminPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function RootLanding() {
  const isTrainingHost = typeof window !== "undefined"
    && window.location.hostname.toLowerCase() === "training.aromacafeinstitute.in";

  return isTrainingHost ? <VSL /> : <Home />;
}

function App() {
  const [location] = useLocation();
  const isLearnPortal = location === "/learn" || location.startsWith("/learn/");

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
        {isLearnPortal && <PwaInstallPrompt />}
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
