"use client";
import type { Appearance, Stripe, StripeAddressElement, StripeElements, StripePaymentElement } from "@stripe/stripe-js";
import { loadStripe } from "@stripe/stripe-js/pure";
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";

/** A business's name and billing address, as Stripe's Address Element gives them. */
export interface BusinessAddress {
  name: string;
  address: { line1: string; line2: string | null; city: string; state: string | null; postal_code: string; country: string };
}

export interface CardHandle {
  /** Saves the card on the SetupIntent; 3-D Secure, if the bank wants it, opens in Stripe's own dialog. */
  confirm(): Promise<{ setupIntentId: string } | { error: string }>;
  /** The business name and address, when they're asked for; an error if they aren't filled in. */
  business(): Promise<BusinessAddress | { error: string } | null>;
}

/** The system's own sans, as on most checkouts: the bill steps out of the game's type. */
export const SHEET_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Stripe's fields on the Pay step, in the bill's ink and type, lit in the screen's colour when focused. */
function appearance(accent: string): Appearance {
  return {
    theme: "night",
    variables: {
      colorPrimary: accent,
      colorBackground: "#0d0a07",
      colorText: "#f6eee2",
      colorTextSecondary: "#cbbfae",
      colorTextPlaceholder: "#6f6355",
      colorDanger: "#f0a084",
      fontFamily: SHEET_FONT,
      fontSizeBase: "15px",
      borderRadius: "6px",
    },
    rules: {
      ".Input": { border: "1px solid #3a3027", boxShadow: "none" },
      ".Input:focus": { borderColor: accent, boxShadow: `0 0 0 3px ${accent}38` },
      ".Label": { color: "#cbbfae" },
      ".Tab": { border: "1px solid #3a3027", backgroundColor: "#0d0a07" },
    },
  };
}

/**
 * The card form: Stripe's Payment Element, in Stripe's own frame on this
 * page, so the card goes from the browser to Stripe and never to Sandchest.
 * Stripe.js loads only when this mounts.
 */
export function CardForm({
  ref,
  clientSecret,
  publishableKey,
  accent,
  business,
  businessName,
  onCountry,
  between,
  onError,
}: {
  ref: Ref<CardHandle>;
  clientSecret: string;
  publishableKey: string;
  /** The screen's colour, a hex value: focus rings and the selected tab. */
  accent: string;
  /** Ask for a business name and billing address too, for invoices. */
  business: boolean;
  /** The company's name, to start the business name from. */
  businessName: string;
  /** The billing address's country as it's picked, for the tax ID field. */
  onCountry: (country: string | null) => void;
  /** Shown between the address and the card: the tax ID field. */
  between?: ReactNode;
  onError: (message: string) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const addressMount = useRef<HTMLDivElement>(null);
  const live = useRef<{ stripe: Stripe; elements: StripeElements; element: StripePaymentElement } | null>(null);
  const address = useRef<StripeAddressElement | null>(null);
  const [ready, setReady] = useState(false);
  const [opened, setOpened] = useState(false);
  const country = useRef(onCountry);
  country.current = onCountry;
  const startName = useRef(businessName);
  const report = useRef(onError);
  report.current = onError;
  // The colour is read when the form opens; it can't change on this step.
  const colour = useRef(accent);

  useEffect(() => {
    let alive = true;
    loadStripe(publishableKey)
      .then((stripe) => {
        if (!alive || !mount.current) return;
        if (!stripe) throw new Error("no stripe");
        const elements = stripe.elements({ clientSecret, appearance: appearance(colour.current) });
        const element = elements.create("payment", { layout: "tabs", terms: { card: "never" } });
        element.on("ready", () => alive && setReady(true));
        element.on("loaderror", () => report.current("The card form couldn’t load. Check your connection and try again."));
        element.mount(mount.current);
        live.current = { stripe, elements, element };
        setOpened(true);
      })
      .catch(() => alive && report.current("The card form couldn’t load. Check your connection and try again."));
    return () => {
      alive = false;
      live.current?.element.destroy();
      live.current = null;
      setReady(false);
      setOpened(false);
    };
  }, [clientSecret, publishableKey]);

  // The business's address, in the same Elements group as the card, so the card takes its billing address
  // from it rather than asking for a country and postcode again.
  useEffect(() => {
    const current = live.current;
    if (!business || !opened || !current || !addressMount.current) return;
    const element = current.elements.create("address", {
      mode: "billing",
      display: { name: "organization" },
      defaultValues: { name: startName.current },
    });
    element.on("change", (event) => country.current(event.value.address.country || null));
    element.mount(addressMount.current);
    address.current = element;
    return () => {
      element.destroy();
      address.current = null;
      country.current(null);
    };
  }, [business, opened]);

  useImperativeHandle(
    ref,
    () => ({
      async confirm() {
        const current = live.current;
        if (!current) return { error: "The card form isn’t ready yet." };
        const { error, setupIntent } = await current.stripe.confirmSetup({
          elements: current.elements,
          redirect: "if_required",
          confirmParams: { return_url: window.location.href },
        });
        if (error) return { error: error.message ?? "The card was declined. Try another." };
        if (setupIntent?.status !== "succeeded") return { error: "The card wasn’t confirmed. Try again, or try another card." };
        return { setupIntentId: setupIntent.id };
      },
      async business() {
        if (!address.current) return null;
        const { complete, value } = await address.current.getValue();
        if (!complete) return { error: "Fill in the business name and address, or turn business invoices off." };
        const { line1, line2, city, state, postal_code, country } = value.address;
        return { name: value.name, address: { line1, line2: line2 || null, city, state: state || null, postal_code, country } };
      },
    }),
    [],
  );

  return (
    <div className="onboard-stripe" data-ready={ready || undefined}>
      {business && <div ref={addressMount} className="onboard-stripe-address" />}
      {between}
      <div ref={mount} />
    </div>
  );
}
