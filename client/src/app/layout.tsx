import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { PreferencesProvider } from '@/lib/preferences';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'টেসলা পুল ঢাকা — স্মার্ট ইভি রাইড শেয়ারিং',
  description:
    'Split Tesla rides across Dhaka zones. Real-time pool matching, live status tracking, and instant fare calculation.',
};

// Runs before first paint: applies the saved theme/language to <html> so a reload
// never flashes the wrong theme. Defaults: light theme, Bangla. When English is
// saved, the page stays hidden (`data-lang-pending`) until React renders it, so
// English users never see a flash of Bangla text; PreferencesProvider clears it.
const initPreferences = `(function(){var d=document.documentElement,t='light',l='bn';try{var st=localStorage.getItem('theme'),sl=localStorage.getItem('lang');if(st==='light'||st==='dark')t=st;if(sl==='en'||sl==='bn')l=sl;}catch(e){}d.setAttribute('data-theme',t);d.lang=l;if(l!=='bn'){d.setAttribute('data-lang-pending','');setTimeout(function(){d.removeAttribute('data-lang-pending')},3000);}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bn" data-theme="light" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: initPreferences }} />
      </head>
      <body>
        <PreferencesProvider>{children}</PreferencesProvider>
      </body>
    </html>
  );
}
