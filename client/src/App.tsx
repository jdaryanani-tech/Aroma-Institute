import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/Home";
import VSL from "@/pages/VSL";
import VSLVideo from "@/pages/VSLVideo";
import CounsellingForm from "@/pages/CounsellingForm";
import Admin from "@/pages/Admin";
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

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/vsl" component={VSL} />
      <Route path="/vsl-video" component={VSLVideo} />
      <Route path="/counselling" component={CounsellingForm} />
      <Route path="/admin" component={Admin} />
      <Route path="/learn" component={LearnLoginPage} />
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

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
