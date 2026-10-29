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
  Star,
  Clock,
  Award,
  Users,
  ChevronRight,
  X,
  Lock,
} from "lucide-react";
import aromaLogo from "@assets/ChatGPT_Image_Feb_24__2026__01_47_11_AM-removebg-preview_1771878331386.png";
import vslThumbnail from "@assets/Barista_Career_in_Three_Months_1793184531131.png";

const VSL_PLAYLIST_URL = "/api/vsl/media/index.m3u8";

const benefits = [
  "Hands-on training on professional espresso machines — not just theory",
  "Learn latte art, brewing methods & café workflow in just 12 weeks",
  "Certification recognised by top cafés & hotel chains across India",
  "Get placed or launch your own café with our industry network",
  "Small batch classes — maximum 10 students — for personal attention",
];

const testimonials = [
  {
    name: "Rahul Mehta",
    city: "Ahmedabad",
    text: "Within 3 weeks of completing the course, I landed a job at a premium café chain. The hands-on training was incredible.",
    stars: 5,
  },
  {
    name: "Priya Shah",
    city: "Surat",
    text: "I opened my own café 6 months after the course. Aroma gave me both the skills and the confidence to do it.",
    stars: 5,
  },
  {
    name: "Kiran Patel",
    city: "Vadodara",
    text: "The latte art and espresso technique I learned here is world-class. My café customers always compliment it.",
    stars: 5,
  },
];

export default function VSL() {
  const formRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoPlaybackTrackerRef = useRef(createVslPlaybackTracker());
  const { toast } = useToast();
  const [showGate, setShowGate] = useState(false);
  const [videoUnlocked, setVideoUnlocked] = useState(false);
  const [videoError, setVideoError] = useState(false);

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
      programInterest: "Professional Barista Certification",
      message: "Requested via video gate",
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
      programInterest: "Professional Barista Certification",
      message: "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: InsertInquiry) => {
      const res = await apiRequest("POST", "/api/inquiries", data);
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Seat Reserved!",
        description: "Our team will call you within 2 hours to confirm.",
      });
      form.reset({
        name: "",
        email: "",
        phone: "",
        programInterest: "Professional Barista Certification",
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
                  <p className="text-white/30 text-xs text-center pt-1">🔒 No spam. We'll only contact you about the program.</p>
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
              Professional Barista Certification — Ahmedabad
            </span>
            <h1 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold leading-tight mb-5">
              Build A Career In The Café Industry{" "}
              <span className="text-amber-400 italic">Without Wasting 3–4 Years</span>{" "}
              Waiting For Your Life To Start
            </h1>
            <p className="text-white/70 text-base sm:text-lg leading-relaxed max-w-2xl mx-auto mb-8">
              Watch how Aroma Institute's 12-week Barista Certification program gives you professional-grade skills, industry connections, and the confidence to work at top cafés — or start your own.
            </p>
          </motion.div>

          {/* Stats Row */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="flex flex-wrap justify-center gap-6 mb-10 text-center"
          >
            {[
              { icon: Users, value: "50+", label: "Students Trained" },
              { icon: Clock, value: "12 Weeks", label: "Intensive Program" },
              { icon: Award, value: "100%", label: "Practical Training" },
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
                onPlay={videoPlaybackTrackerRef.current.onPlay}
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
            Reserve My Seat — Free Consultation
            <ArrowDown className="h-4 w-4" />
          </button>
          <p className="text-white/40 text-xs mt-3">Limited seats available · No payment required to apply</p>
        </motion.div>
      </section>

      {/* Benefits */}
      <section className="py-14 px-4 bg-[#130e08]" data-testid="section-vsl-benefits">
        <div className="max-w-2xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <h2 className="font-serif text-2xl sm:text-3xl font-bold text-center mb-2">
              What You'll Get in This Program
            </h2>
            <p className="text-white/50 text-sm text-center mb-8">Everything you need to become a certified, job-ready barista.</p>
            <ul className="space-y-4">
              {benefits.map((b, i) => (
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
          </motion.div>
        </div>
      </section>

      {/* Urgency Strip */}
      <div className="bg-amber-400 py-4 px-4" data-testid="section-urgency">
        <p className="text-[#0e0a07] text-center font-bold text-sm sm:text-base">
          🎓 Next batch starts soon · Only 10 seats per batch · <button onClick={scrollToForm} className="underline underline-offset-2 hover:no-underline">Secure your spot now →</button>
        </p>
      </div>

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
              What Our Students Say
            </h2>
            <p className="text-white/50 text-sm text-center mb-8">Real stories from people who took the leap.</p>
            <div className="grid sm:grid-cols-3 gap-5">
              {testimonials.map((t, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.1 }}
                  className="bg-white/5 border border-white/10 rounded-2xl p-5"
                  data-testid={`testimonial-card-${i}`}
                >
                  <div className="flex gap-0.5 mb-3">
                    {Array.from({ length: t.stars }).map((_, s) => (
                      <Star key={s} className="h-3.5 w-3.5 text-amber-400 fill-amber-400" />
                    ))}
                  </div>
                  <p className="text-white/75 text-sm leading-relaxed mb-4">"{t.text}"</p>
                  <div>
                    <p className="font-semibold text-white text-sm">{t.name}</p>
                    <p className="text-white/40 text-xs">{t.city}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>
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
              Free Consultation Call
            </span>
            <h2 className="font-serif text-2xl sm:text-3xl font-bold mb-3">
              Reserve Your Seat Today
            </h2>
            <p className="text-white/55 text-sm leading-relaxed">
              Fill in your details and our team will call you within 2 hours to answer any questions and confirm your spot.
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

                <input type="hidden" {...form.register("programInterest")} value="Professional Barista Certification" />

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
                      Get My Free Consultation Call
                      <ChevronRight className="h-5 w-5" />
                    </>
                  )}
                </button>

                <p className="text-white/30 text-xs text-center pt-1">
                  🔒 Your information is 100% private. We never share your details.
                </p>
              </form>
            </Form>
          </motion.div>

          {/* Trust signals */}
          <div className="mt-6 flex flex-wrap justify-center gap-4">
            {[
              "✅ No payment to apply",
              "📞 Call within 2 hours",
              "🎓 Certified program",
            ].map((item) => (
              <span key={item} className="text-white/45 text-xs">{item}</span>
            ))}
          </div>
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
