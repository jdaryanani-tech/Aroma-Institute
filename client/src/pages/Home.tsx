import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import AboutSection from "@/components/AboutSection";
import ProgramsSection from "@/components/ProgramsSection";
import TrainingSection from "@/components/TrainingSection";
import PlacementSection from "@/components/PlacementSection";
import AdmissionSection from "@/components/AdmissionSection";
import CTASection from "@/components/CTASection";
import ContactForm from "@/components/ContactForm";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <HeroSection />
      <AboutSection />
      <ProgramsSection />
      <TrainingSection />
      <PlacementSection />
      <AdmissionSection />
      <CTASection />
      <ContactForm />
      <Footer />
    </div>
  );
}
