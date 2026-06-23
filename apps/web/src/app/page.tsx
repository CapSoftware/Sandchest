import { Header } from "@/components/go/header";
import { Hero } from "@/components/go/hero";
import { ChestReveal } from "@/components/go/chest-reveal";
import { Models } from "@/components/go/models";
import { How } from "@/components/go/how";
import { Pricing } from "@/components/go/pricing";
import { Faq } from "@/components/go/faq";
import { Newsletter } from "@/components/go/newsletter";
import { Footer } from "@/components/go/footer";

export default function Home() {
  return (
    <div className="page">
      <Header />
      <main id="main">
        <Hero />
        <ChestReveal />
        <Models />
        <How />
        <Pricing />
        <Faq />
        <Newsletter />
      </main>
      <Footer />
    </div>
  );
}
