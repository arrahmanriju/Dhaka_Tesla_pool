'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { isAuthenticated, getUser } from '@/lib/auth';
import { usePreferences } from '@/lib/preferences';
import { PreferenceControls } from '@/components/PreferenceControls';

export default function Home() {
  const router = useRouter();
  const { t } = usePreferences();

  useEffect(() => {
    if (isAuthenticated()) {
      const user = getUser();
      router.replace(user?.role === 'DRIVER' ? '/driver' : '/passenger');
    }
  }, [router]);

  return (
    <div className="hero">
      <PreferenceControls floating />
      <div className="hero__content animate-in">
        <div className="hero__eyebrow">
          <span>🛺</span>
          {t('hero.eyebrow')}
        </div>
        <h1 className="hero__title">
          {t('hero.title1')} <span>{t('hero.title2')}</span>,<br />{t('hero.title3')}
        </h1>
        <p className="hero__desc">
          {t('hero.desc')}
        </p>
        <div className="hero__ctas">
          <a href="/auth" className="btn btn--primary btn--lg">
            {t('hero.cta.start')}
          </a>
          <a href="/auth" className="btn btn--secondary btn--lg">
            {t('hero.cta.signin')}
          </a>
        </div>
      </div>
    </div>
  );
}
