import { defineComponents } from "blume";
import Logo from "./components/Logo.astro";
import Footer from "./components/Footer.astro";
export default defineComponents({ layout: { Logo, Footer } });
