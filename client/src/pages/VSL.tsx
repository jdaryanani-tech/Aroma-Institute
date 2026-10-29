import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type Hls from "hls.js";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { insertInquirySchema, type InsertInquiry } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { createVslPlaybackTracker } from "@/lib/analytics";
import { useToast } from "@/hooks/use-toast";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import {
  CheckCircle2,
  Play,
  Phone,
  ArrowDown,
  Award,
  ChevronRight,
  X,
  Lock,
  Coffee,
  BookOpen,
  ClipboardCheck,
  IndianRupee,
} from "lucide-react";
import aromaLogo from "@assets/ChatGPT_Image_Feb_24__2026__01_47_11_AM-removebg-preview_1771878331386.png";
import vslThumbnail from "@assets/Barista_Career_in_Three_Months_1793184531131.png";

const VSL_PLAYLIST_URL = "/api/vsl/media/index.m3u8";
const COUNSELLING_WHATSAPP_URL =
  "https://wa.me/919274868669?text=Hello%2C%20I%20would%20like%20to%20book%20a%20free%20Aroma%20LEAP%20Career%20Counselling%20Session.%20Please%20help%20me%20arrange%20a%20suitable%20time.";

const learningAreas = [
  "Coffee fundamentals and beverage preparation",
  "Espresso extraction, milk science and steaming",
  "Latte art and consistent drink preparation",
  "Hospitality, customer service and communication",
  "Hygiene, professional behaviour and teamwork",
  "Café operations, workflow and workplace expectations",
];

const studentJourneys = [
  { name: "Shivank", story: "Moved from working in a tiles factory to a café placement at Rostea.", outcome: "Reported earning: ₹19,000 per month" },
  { name: "Khushi", story: "Balanced BBA studies, training and internship commitments before a placement at Rostea.", outcome: "Reported earning: ₹15,000 per month" },
  { name: "Siddharaj", story: "Moved from working in a French fries factory to a Junior Barista role at FYRO.", outcome: "Reported earning: ₹20,000 per month" },
  { name: "Manoj Singh", story: "Started with a stipend and progressed to a Project Head role with Kaffa.", outcome: "Started with a stipend of ₹8,000" },
];

export default function VSL() {
  const formRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoPlaybackTrackerRef = useRef(createVslPlaybackTracker());
  const { toast } = useToast();
  const [showGate, setShowGate] = useState(false);
  const [videoUnlocked, setVideoUnlocked] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [applicationSubmitted, setApplicationSubmitted] = useState(false);

  useEffect(() => {
    if (!videoUnlocked || !videoRef.current) return;
    const video = videoRef.current;
    setVideoError(false);

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = VSL_PLAYLIST_URL;
      return () => {
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
    }

    let hls: Hls | undefined;
    let cancelled = false;
    void import("hls.js")
      .then(({ default: HlsPlayer }) => {
        if (cancelled) return;
        if (!HlsPlayer.isSupported()) {
          setVideoError(true);
          return;
        }
        hls = new HlsPlayer();
        hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (data.fatal) setVideoError(true);
        });
        hls.loadSource(VSL_PLAYLIST_URL);
        hls.attachMedia(video);
      })
      .catch(() => {
        if (!cancelled) setVideoError(true);
      });
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [videoUnlocked]);

  const scrollToForm = () => {
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const gateForm = useForm<InsertInquiry>({
    resolver: zodResolver(insertInquirySchema),
    defaultValues: {
      name: "",
      email: "watch@aromainstitute.in",
      phone: "",
      programInterest: "Aroma LEAP",
      message: "Requested access to Aroma LEAP program video",
    },
  });

  const gateMutation = useMutation({
    mutationFn: async (data: InsertInquiry) => {
      const res = await apiRequest("POST", "/api/inquiries", data);
      return res.json();
    },
    onSuccess: () => {
      setShowGate(false);
      setVideoUnlocked(true);
    },
    onError: () => {
      toast({
        title: "Something went wrong",
        description: "Please try again.",
        variant: "destructive",
      });
    },
  });

  const form = useForm<InsertInquiry>({
    resolver: zodResolver(insertInquirySchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      programInterest: "Aroma LEAP",
      message: "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: InsertInquiry) => {
      const res = await apiRequest("POST", "/api/inquiries", data);
      return res.json();
    },
    onSuccess: () => {
      setApplicationSubmitted(true);
      toast({
        title: "Application received",
        description: "Next, use WhatsApp to arrange your free Career Counselling Session.",
      });
      form.reset({
        name: "",
        email: "",
        phone: "",
        programInterest: "Aroma LEAP",
        message: "",
      });
    },
    onError: () => {
      toast({
        title: "Something went wrong",
        description: "Please call us directly at +91 9274868669",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: InsertInquiry) => {
    setApplicationSubmitted(false);
    mutation.mutate(data);
  };

  return (
    <div className="min-h-screen bg-[#0e0a07] text-white" data-testid="page-vsl">

      {/* Video Gate Modal */}
      <AnimatePresence>
        {showGate && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center px-4"
            data-testid="modal-video-gate"
          >
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowGate(false)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 16 }}
              transition={{ duration: 0.25 }}
              className="relative w-full max-w-md bg-[#1a1109] border border-white/15 rounded-2xl p-6 sm:p-8 shadow-2xl"
            >
              <button
                onClick={() => setShowGate(false)}
                className="absolute top-4 right-4 text-white/30 hover:text-white/70 transition-colors"
                data-testid="modal-close"
              >
                <X className="h-5 w-5" />
              </button>

              <div className="text-center mb-6">
                <div className="w-12 h-12 rounded-full bg-amber-400 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-amber-400/30">
                  <Play className="h-5 w-5 text-[#0e0a07] ml-0.5" fill="currentColor" />
                </div>
                <h3 className="font-serif text-xl font-bold text-white mb-1">Watch the Free Training</h3>
                <p className="text-white/50 text-sm">Enter your details below to unlock the video instantly.</p>
              </div>

              <Form {...gateForm}>
                <form
                  onSubmit={gateForm.handleSubmit((data) => gateMutation.mutate(data))}
                  className="space-y-3"
                >
                  <FormField
                    control={gateForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <input
                            placeholder="Your Full Name *"
                            className="w-full h-11 px-4 rounded-lg border border-white/20 text-white placeholder:text-white/40 focus:outline-none focus:border-amber-400/60 text-sm transition-colors"
                            style={{ background: "rgba(255,255,255,0.08)" }}
                            {...field}
                            data-testid="gate-input-name"
                          />
                        </FormControl>
                        <FormMessage className="text-red-400 text-xs" />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={gateForm.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <input
                            placeholder="Your Phone Number *"
                            className="w-full h-11 px-4 rounded-lg border border-white/20 text-white placeholder:text-white/40 focus:outline-none focus:border-amber-400/60 text-sm transition-colors"
                            style={{ background: "rgba(255,255,255,0.08)" }}
                            {...field}
                            data-testid="gate-input-phone"
                          />
                        </FormControl>
                        <FormMessage className="text-red-400 text-xs" />
                      </FormItem>
                    )}
                  />
                  <input type="hidden" {...gateForm.register("email")} />
                  <input type="hidden" {...gateForm.register("programInterest")} />
                  <input type="hidden" {...gateForm.register("message")} />

                  <button
                    type="submit"
                    disabled={gateMutation.isPending}
                    className="w-full h-12 flex items-center justify-center gap-2 bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-[#0e0a07] font-bold rounded-xl transition-colors mt-2"
                    data-testid="gate-button-submit"
                  >
                    {gateMutation.isPending ? "Unlocking..." : (
                      <>
                        <Play className="h-4 w-4 ml-0.5" fill="currentColor" />
                        Unlock & Watch Free
                      </>
                    )}
                  </button>
                  <p className="text-white/45 text-xs text-center pt-1">
                    Your details will be used to respond to your program enquiry.
                  </p>
                </form>
              </Form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sticky Top Bar */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-[#0e0a07]/95 backdrop-blur border-b border-white/10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src={aromaLogo}
              alt="Aroma Institute"
              className="h-9 w-auto object-contain"
            />
            <div className="hidden sm:block">
              <span className="font-serif font-black text-white text-lg leading-none block tracking-tight">AROMA</span>
              <span className="text-white/50 text-[9px] uppercase tracking-wider leading-tight block">Institute of Cafe & Hospitality Management</span>
            </div>
          </div>
          <a
            href="tel:+919274868669"
            className="flex items-center gap-2 text-amber-400 font-semibold text-sm hover:text-amber-300 transition-colors"
            data-testid="link-phone-topbar"
          >
            <Phone className="h-4 w-4" />
            <span>+91 92748 68669</span>
          </a>
        </div>
      </div>

      {/* Hero */}
      <section className="pt-28 pb-10 px-4" data-testid="section-vsl-hero">
        <div className="max-w-3xl mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <span className="inline-block bg-amber-400/15 border border-amber-400/30 text-amber-400 text-xs font-semibold uppercase tracking-widest px-4 py-1.5 rounded-full mb-6">
              Aroma LEAP · Ahmedabad and Gujarat
            </span>
            <h1 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold leading-tight mb-5">
              Start Working Towards Your{" "}
              <span className="text-amber-400 italic">Professional Barista Career</span>{" "}
              in 3 Months
            </h1>
            <p className="text-white/70 text-base sm:text-lg leading-relaxed max-w-2xl mx-auto mb-8">
              Aroma LEAP combines professional Barista training, practical café exposure through an internship pathway, competency assessment, certification and placement assistance. No prior coffee knowledge or café experience is required to begin.
            </p>
            <p className="text-white/50 text-sm mb-7">For aspiring Baristas aged 18–24 in Ahmedabad and Gujarat.</p>
          </motion.div>

          {/* Stats Row */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="flex flex-wrap justify-center gap-6 mb-10 text-center"
          >
            {[
              { icon: Coffee, value: "3 months", label: "Professional career program" },
              { icon: BookOpen, value: "Learn · Earn", label: "Practical café exposure pathway" },
              { icon: Award, value: "Assess · Prepare", label: "Certification and placement assistance" },
            ].map(({ icon: Icon, value, label }) => (
              <div key={label} className="flex items-center gap-2.5 bg-white/5 border border-white/10 rounded-xl px-5 py-3">
                <Icon className="h-5 w-5 text-amber-400 shrink-0" />
                <div className="text-left">
                  <p className="font-bold text-white text-base leading-none">{value}</p>
                  <p className="text-white/50 text-xs mt-0.5">{label}</p>
                </div>
              </div>
            ))}
          </motion.div>
        </div>

        {/* Video Placeholder */}
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="max-w-3xl mx-auto"
          data-testid="video-placeholder"
        >
          {videoUnlocked ? (
            <div
              className="relative aspect-video overflow-hidden rounded-2xl border border-amber-400/30 bg-[#1a1109] shadow-2xl"
              data-testid="video-embed"
            >
              <video
                ref={videoRef}
                className="absolute inset-0 h-full w-full"
                poster={vslThumbnail}
                controls
                playsInline
                preload="metadata"
                aria-label="Aroma Institute video sales letter"
                data-testid="vsl-video"
                onError={() => setVideoError(true)}
                onPlay={(event) =>
                  videoPlaybackTrackerRef.current.onPlay(event.currentTarget.currentTime)
                }
                onTimeUpdate={(event) => {
                  const video = event.currentTarget;
                  videoPlaybackTrackerRef.current.onTimeUpdate(
                    video.currentTime,
                    video.duration,
                    video.seeking,
                  );
                }}
                onSeeked={(event) =>
                  videoPlaybackTrackerRef.current.onSeeked(event.currentTarget.currentTime)
                }
                onEnded={videoPlaybackTrackerRef.current.onEnded}
              />
              {videoError && (
                <p className="absolute inset-x-4 bottom-4 rounded-lg bg-black/80 px-4 py-3 text-center text-sm text-white" role="alert">
                  The video could not be loaded. Please refresh the page and try again.
                </p>
              )}
            </div>
          ) : (
            <button
              onClick={() => setShowGate(true)}
              className="w-full text-left"
              data-testid="button-play-gate"
            >
              <div className="relative rounded-2xl overflow-hidden border border-white/10 shadow-2xl bg-[#1a1109] aspect-video flex items-center justify-center group">
                <img
                  src={vslThumbnail}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover opacity-60 transition-opacity duration-300 group-hover:opacity-75"
                />
                <div className="absolute inset-0 bg-gradient-to-br from-black/25 via-black/45 to-black/70" />
                <div className="text-center z-10 px-6">
                  <div className="w-20 h-20 rounded-full bg-amber-400 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-amber-400/30 group-hover:scale-110 transition-transform duration-300">
                    <Play className="h-8 w-8 text-[#0e0a07] ml-1" fill="currentColor" />
                  </div>
                  <p className="text-white/70 text-sm font-semibold">Watch the Free Training</p>
                  <p className="text-white/40 text-xs mt-1 flex items-center justify-center gap-1">
                    <Lock className="h-3 w-3" /> Enter your details to unlock
                  </p>
                </div>
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-400/0 via-amber-400/60 to-amber-400/0" />
              </div>
            </button>
          )}
        </motion.div>

        {/* CTA after video */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="text-center mt-8"
        >
          <button
            onClick={scrollToForm}
            className="inline-flex items-center gap-2 bg-amber-400 hover:bg-amber-300 text-[#0e0a07] font-bold text-base px-8 py-4 rounded-xl transition-all duration-200 shadow-lg shadow-amber-400/20 hover:shadow-amber-400/40 hover:scale-[1.02]"
            data-testid="button-cta-hero"
          >
            Apply for Free Career Counselling
            <ArrowDown className="h-4 w-4" />
          </button>
          <p className="text-white/45 text-xs mt-3 max-w-xl mx-auto leading-relaxed">Employment is not guaranteed. Outcomes depend on individual skills, interview performance, employer requirements and available opportunities.</p>
        </motion.div>
      </section>

      {/* Audience and career preparation */}
      <section className="py-14 px-4 bg-[#130e08]" data-testid="section-vsl-benefits">
        <div className="max-w-4xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <div className="max-w-2xl mx-auto text-center mb-10">
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-[0.2em] mb-3">Is this you?</p>
              <h2 className="font-serif text-2xl sm:text-3xl font-bold mb-3">
                Want to start earning, but not sure where to begin?
              </h2>
              <p className="text-white/60 text-sm leading-relaxed">
                You may have completed 12th standard, be studying in college, have graduated without finding the right opportunity, or be working in a factory or another job. If you want to explore café work, it can be hard to know which skills employers expect and how to gain practical experience.
              </p>
              <p className="text-white/60 text-sm leading-relaxed mt-3">
                The challenge is not necessarily your willingness to work. You need a clear way to develop relevant skills and prepare for the workplace.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-3 mb-10">
              {[
                ["Completed 12th standard", "Explore a practical career path."],
                ["Studying in college", "Build employable skills alongside your studies."],
                ["Recently graduated", "Prepare to pursue your first opportunity."],
                ["Working in another field", "Explore a career in cafés and hospitality."],
              ].map(([title, text]) => (
                <div key={title} className="rounded-xl border border-white/10 bg-white/[0.035] p-4 sm:p-5">
                  <h3 className="text-white font-semibold text-sm mb-1">{title}</h3>
                  <p className="text-white/55 text-sm leading-relaxed">{text}</p>
                </div>
              ))}
            </div>

            <div className="max-w-2xl mx-auto text-center mb-8">
              <h3 className="font-serif text-xl sm:text-2xl font-bold mb-3">
                Professional cafés need more than coffee recipes.
              </h3>
              <p className="text-white/60 text-sm leading-relaxed">
                Consistent beverages, espresso extraction, milk steaming, hygiene, customer service and teamwork all contribute to café work. You need knowledge, practice, industry exposure and career preparation.
              </p>
            </div>

            <div className="max-w-2xl mx-auto">
              <h3 className="font-serif text-xl sm:text-2xl font-bold text-center mb-2">
                Develop skills that go beyond coffee recipes
              </h3>
              <p className="text-white/50 text-sm text-center mb-6">
                Aroma LEAP helps beginners work towards a foundation they can apply in a professional café environment.
              </p>
              <ul className="space-y-3">
                {learningAreas.map((b, i) => (
                  <motion.li
                    key={i}
                    initial={{ opacity: 0, x: -16 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.4, delay: i * 0.08 }}
                    className="flex items-start gap-3 bg-white/5 border border-white/8 rounded-xl px-5 py-4"
                    data-testid={`benefit-item-${i}`}
                  >
                    <CheckCircle2 className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                    <span className="text-white/85 text-sm sm:text-base leading-relaxed">{b}</span>
                  </motion.li>
                ))}
              </ul>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Urgency Strip */}
      <div className="bg-amber-400 py-4 px-4" data-testid="section-urgency">
        <p className="text-[#0e0a07] text-center font-bold text-sm sm:text-base">
          Learn. Earn. Advance. Pay. · <button onClick={scrollToForm} className="underline underline-offset-2 hover:no-underline">Explore the program</button>
        </p>
      </div>

      <section className="py-16 px-4" data-testid="section-leap-pathway">
        <div className="max-w-4xl mx-auto">
          <div className="max-w-2xl mb-9">
            <p className="text-amber-400 text-xs font-semibold uppercase tracking-[0.2em] mb-3">A structured pathway</p>
            <h2 className="font-serif text-2xl sm:text-3xl font-bold mb-3">More than a class. A step-by-step start.</h2>
            <p className="text-white/55 text-sm leading-relaxed">Aroma LEAP brings learning, workplace exposure and career preparation together over three months. Your counselling conversation is the place to understand the details and decide whether it fits.</p>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {[
              { icon: BookOpen, title: "LEARN", text: "Build coffee knowledge, beverage skills, hospitality awareness and professional foundations." },
              { icon: Coffee, title: "EARN", text: "Explore practical industry exposure through the café internship pathway, subject to the participating café’s terms." },
              { icon: ClipboardCheck, title: "ADVANCE", text: "Work towards competency assessment, interview preparation and placement assistance." },
              { icon: IndianRupee, title: "PAY", text: "Review the program fee, scholarship eligibility and payment options before finalising admission." },
            ].map(({ icon: Icon, title, text }) => (
              <div key={title} className="flex gap-4 rounded-xl border border-white/10 bg-white/[0.035] p-5 sm:p-6">
                <div className="h-10 w-10 shrink-0 rounded-lg bg-amber-400/10 flex items-center justify-center">
                  <Icon className="h-5 w-5 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-amber-400 text-xs font-bold tracking-[0.18em] mb-2">{title}</h3>
                  <p className="text-white/70 text-sm leading-relaxed">{text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-16 px-4 bg-[#130e08]" data-testid="section-internship">
        <div className="max-w-4xl mx-auto grid md:grid-cols-[1fr_0.8fr] gap-8 items-center">
          <div>
            <p className="text-amber-400 text-xs font-semibold uppercase tracking-[0.2em] mb-3">Practical café exposure</p>
            <h2 className="font-serif text-2xl sm:text-3xl font-bold mb-4">Learn how a real café works.</h2>
            <p className="text-white/65 text-sm leading-relaxed mb-4">Through Aroma’s internship pathway, you have an opportunity to experience a working café, develop your abilities, work with a team and learn how professional service operates.</p>
            <p className="text-white/65 text-sm leading-relaxed">Schedules and responsibilities can be substantial. Discuss working hours, weekly schedule, training commitments, stipend conditions and all applicable terms during counselling.</p>
          </div>
          <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.07] p-6 sm:p-7">
            <p className="text-white/55 text-xs font-semibold uppercase tracking-widest mb-3">Target internship stipend</p>
            <p className="font-serif text-3xl sm:text-4xl font-bold text-amber-400 mb-3">₹12,000–₹15,000<span className="text-base text-white/55 font-sans font-medium"> / month</span></p>
            <p className="text-white/65 text-sm leading-relaxed mb-4">Target amount from Day 1, subject to the participating café’s terms. The internship is assigned through Aroma’s pathway, and the participating café pays the stipend directly to the student.</p>
            <p className="text-white/45 text-xs leading-relaxed border-t border-white/10 pt-4">An internship offers practical industry exposure; it does not guarantee permanent employment.</p>
          </div>
        </div>
      </section>

      <section className="py-16 px-4" data-testid="section-certification">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-10">
          <div>
            <p className="text-amber-400 text-xs font-semibold uppercase tracking-[0.2em] mb-3">Career preparation</p>
            <h2 className="font-serif text-2xl sm:text-3xl font-bold mb-4">Prepare for the next step, not just the final class.</h2>
            <p className="text-white/60 text-sm leading-relaxed">The pathway includes competency assessment, résumé development, interview preparation, employer introductions and opportunity exploration, plus placement assistance and continued support until placement.</p>
          </div>
          <div className="space-y-3">
            {["Certification, subject to meeting required competencies", "Résumé and interview preparation", "Employer introductions and opportunity exploration", "Placement assistance and continued support"].map((item) => (
              <div key={item} className="flex items-start gap-3 border-b border-white/10 pb-3 text-sm text-white/70">
                <CheckCircle2 className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                <span>{item}</span>
              </div>
            ))}
            <p className="text-white/45 text-xs leading-relaxed pt-2">Aroma Institute does not guarantee employment, a specific salary or placement within a fixed period. Employment depends on your skills, interview performance, employer requirements and available opportunities.</p>
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="py-14 px-4" data-testid="section-vsl-testimonials">
        <div className="max-w-3xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <h2 className="font-serif text-2xl sm:text-3xl font-bold text-center mb-2">
              Student journeys
            </h2>
            <p className="text-white/50 text-sm text-center mb-8">Examples shared by Aroma Institute. Every person's pathway and outcome is different.</p>
            <div className="grid sm:grid-cols-2 gap-5">
              {studentJourneys.map((t, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.1 }}
                  className="bg-white/5 border border-white/10 rounded-2xl p-5"
                  data-testid={`testimonial-card-${i}`}
                >
                  <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-3">A reported journey</p>
                  <p className="text-white/75 text-sm leading-relaxed mb-4">{t.story}</p>
                  <div>
                    <p className="font-semibold text-white text-sm">{t.name}</p>
                    <p className="text-white/50 text-xs mt-1">{t.outcome}</p>
                  </div>
                </motion.div>
              ))}
            </div>
            <p className="text-white/40 text-xs leading-relaxed text-center mt-6">These are individual outcomes, not promises of the same result for every student. Employment and earnings depend on individual skills, interview performance, employer requirements and available opportunities.</p>
          </motion.div>
        </div>
      </section>

      <section className="py-16 px-4 bg-[#130e08]" data-testid="section-fees">
        <div className="max-w-4xl mx-auto grid md:grid-cols-[1fr_0.85fr] gap-10">
          <div>
            <p className="text-amber-400 text-xs font-semibold uppercase tracking-[0.2em] mb-3">Fees and scholarship</p>
            <h2 className="font-serif text-2xl sm:text-3xl font-bold mb-4">Understand your investment before you enrol.</h2>
            <p className="text-white/60 text-sm leading-relaxed mb-6">Apply first, then discuss the program with the team. You may bring a parent or guardian to review the training, internship pathway, career preparation and financial terms before deciding.</p>
            <div className="space-y-3 text-sm text-white/65">
              <p className="flex gap-3"><CheckCircle2 className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" /><span>Confirm scholarship eligibility, admission and applicable terms during counselling.</span></p>
              <p className="flex gap-3"><CheckCircle2 className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" /><span>The team will explain instalments, payment terms and total payable amount before admission is finalised.</span></p>
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-6 sm:p-7">
            <p className="text-white/50 text-xs uppercase tracking-widest mb-2">Standard program fee</p>
            <p className="text-white/75 text-xl font-semibold line-through decoration-white/30 mb-5">₹60,000</p>
            <div className="border-l-2 border-amber-400 pl-4 mb-5">
              <p className="text-amber-400 text-sm font-semibold mb-1">Decision-based scholarship: ₹15,000</p>
              <p className="text-white/60 text-sm leading-relaxed">Eligible applicants who decide within applicable conditions may qualify. Program fee after scholarship: <strong className="text-white">₹45,000</strong>.</p>
            </div>
            <p className="text-white/55 text-xs leading-relaxed mb-4">Applying is the first step to reserve scholarship eligibility. Final eligibility, admission and terms are confirmed during counselling.</p>
            <p className="text-white/55 text-xs leading-relaxed border-t border-white/10 pt-4">A six-month payment option is available for discussion. Confirm instalments, payment terms and total payable amount with the team before finalising admission.</p>
          </div>
        </div>
      </section>

      <section className="py-14 px-4" data-testid="section-apply-steps">
        <div className="max-w-4xl mx-auto">
          <div className="max-w-xl mb-8">
            <p className="text-amber-400 text-xs font-semibold uppercase tracking-[0.2em] mb-3">A clear next step</p>
            <h2 className="font-serif text-2xl sm:text-3xl font-bold mb-3">Your next step is a conversation.</h2>
            <p className="text-white/55 text-sm leading-relaxed">Ask questions, include your parent or guardian, and decide with a full understanding of the commitment.</p>
          </div>
          <div className="grid sm:grid-cols-2 gap-x-8">
            {[
              ["01", "Apply", "Send your details to request a free Career Counselling Session."],
              ["02", "Book your session", "Use the WhatsApp chatbot to arrange a suitable counselling appointment."],
              ["03", "Bring your family", "Review the program, schedule, internship terms, fees and payment options together."],
              ["04", "Decide with clarity", "Consider whether the program fits your goals, schedule and circumstances before admission."],
            ].map(([number, title, text]) => (
              <div key={number} className="flex gap-4 border-t border-white/10 py-5">
                <span className="font-serif text-2xl text-amber-400/70">{number}</span>
                <div>
                  <h3 className="text-white font-semibold text-sm mb-1">{title}</h3>
                  <p className="text-white/50 text-sm leading-relaxed">{text}</p>
                  {number === "02" && (
                    <a
                      href={COUNSELLING_WHATSAPP_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex mt-3 text-sm font-semibold text-amber-400 underline underline-offset-4 hover:text-amber-300"
                    >
                      Continue on WhatsApp
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Inquiry Form */}
      <section
        id="vsl-form"
        ref={formRef}
        className="py-16 px-4 bg-[#130e08]"
        data-testid="section-vsl-form"
      >
        <div className="max-w-lg mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="text-center mb-8"
          >
            <span className="inline-block bg-amber-400/15 border border-amber-400/30 text-amber-400 text-xs font-semibold uppercase tracking-widest px-4 py-1.5 rounded-full mb-4">
              Free Career Counselling Session
            </span>
            <h2 className="font-serif text-2xl sm:text-3xl font-bold mb-3">
              Explore Whether Aroma LEAP Fits You
            </h2>
            <p className="text-white/55 text-sm leading-relaxed">
              Share your details to request a conversation about your goals, the skills you need and whether this program suits your circumstances.
            </p>
            <p className="text-white/40 text-xs leading-relaxed mt-4">
              Use the session to discuss skills and experience for a Barista career, possible gaps, practical next steps and whether Aroma LEAP fits your goals. You can bring a parent or guardian.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="bg-white/5 border border-white/10 rounded-2xl p-6 sm:p-8"
          >
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <input
                          placeholder="Your Full Name *"
                          className="w-full h-12 px-4 rounded-md border border-white/20 bg-white/10 text-white placeholder:text-white/40 focus:outline-none focus:border-amber-400/70 focus:ring-1 focus:ring-amber-400/40 transition-colors text-sm"
                          {...field}
                          data-testid="vsl-input-name"
                        />
                      </FormControl>
                      <FormMessage className="text-red-400 text-xs" />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <input
                          placeholder="Your Phone Number *"
                          className="w-full h-12 px-4 rounded-md border border-white/20 bg-white/10 text-white placeholder:text-white/40 focus:outline-none focus:border-amber-400/70 focus:ring-1 focus:ring-amber-400/40 transition-colors text-sm"
                          {...field}
                          data-testid="vsl-input-phone"
                        />
                      </FormControl>
                      <FormMessage className="text-red-400 text-xs" />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <input
                          type="email"
                          placeholder="Your Email Address *"
                          className="w-full h-12 px-4 rounded-md border border-white/20 bg-white/10 text-white placeholder:text-white/40 focus:outline-none focus:border-amber-400/70 focus:ring-1 focus:ring-amber-400/40 transition-colors text-sm"
                          {...field}
                          data-testid="vsl-input-email"
                        />
                      </FormControl>
                      <FormMessage className="text-red-400 text-xs" />
                    </FormItem>
                  )}
                />

                <input type="hidden" {...form.register("programInterest")} value="Aroma LEAP" />

                <button
                  type="submit"
                  disabled={mutation.isPending}
                  className="w-full flex items-center justify-center gap-2 bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-[#0e0a07] font-bold text-base h-13 py-4 rounded-xl transition-all duration-200 shadow-lg shadow-amber-400/20 hover:shadow-amber-400/40"
                  data-testid="vsl-button-submit"
                >
                  {mutation.isPending ? (
                    "Submitting..."
                  ) : (
                    <>
                      Apply for Free Career Counselling
                      <ChevronRight className="h-5 w-5" />
                    </>
                  )}
                </button>

                <p className="text-white/30 text-xs text-center pt-1">
                  Your details help the team respond to your enquiry.
                </p>
              </form>
            </Form>
          </motion.div>

          {applicationSubmitted && (
            <div
              className="mt-5 rounded-2xl border border-amber-400/25 bg-amber-400/[0.07] p-5 text-center"
              data-testid="vsl-application-success"
              role="status"
            >
              <h3 className="text-white font-semibold mb-2">Your application has been received.</h3>
              <p className="text-white/60 text-sm leading-relaxed mb-4">
                Next, use the WhatsApp chatbot to book a suitable Career Counselling Session.
              </p>
              <a
                href={COUNSELLING_WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-xl bg-amber-400 px-5 py-3 font-bold text-sm text-[#0e0a07] transition-colors hover:bg-amber-300"
              >
                Book on WhatsApp
              </a>
            </div>
          )}

          {/* Trust signals */}
          <div className="mt-6 flex flex-wrap justify-center gap-4">
            {[
              "No prior café experience required",
              "Parent or guardian welcome",
              "Discuss terms before admission",
            ].map((item) => (
              <span key={item} className="text-white/45 text-xs">{item}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="px-4 pb-10" data-testid="section-career-transparency">
        <div className="max-w-3xl mx-auto border-t border-white/10 pt-8 text-center">
          <p className="text-amber-400 text-xs font-semibold uppercase tracking-[0.2em] mb-2">Career transparency</p>
          <p className="text-white/40 text-xs leading-relaxed">
            Aroma Institute does not guarantee employment, a specific salary or placement within a fixed period. Internship opportunities, stipends, scholarships, certification and payment arrangements are subject to applicable requirements and terms.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10 py-8 px-4" data-testid="footer-vsl">
        <div className="max-w-3xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
          <div className="flex items-center gap-3">
            <img src={aromaLogo} alt="Aroma Institute" className="h-8 w-auto opacity-80" />
            <div>
              <p className="font-serif font-bold text-white text-sm leading-none">AROMA</p>
              <p className="text-white/40 text-[10px] uppercase tracking-wide">Institute of Cafe & Hospitality</p>
            </div>
          </div>
          <div className="text-white/35 text-xs space-y-1">
            <p>Gurukul Road, Memnagar, Ahmedabad, Gujarat</p>
            <p>
              <a href="tel:+919274868669" className="hover:text-amber-400 transition-colors">+91 9274868669</a>
              {" · "}
              <a href="mailto:admissions@aromainstitute.in" className="hover:text-amber-400 transition-colors">admissions@aromainstitute.in</a>
            </p>
            <p className="mt-1">© {new Date().getFullYear()} Aroma Institute. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
