export const dynamic = 'force-dynamic';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { LeadsComponent } from '@gitroom/frontend/components/rektrs/leads.component';

const brandOn = process.env.NEXT_PUBLIC_REKTRS_SOCIAL_BRAND === 'true';

export const metadata: Metadata = {
  title: `${brandOn ? 'REKTRS Social' : 'Postiz'} Leads`,
  description: '',
};

export default async function Page() {
  if (!brandOn) {
    notFound();
  }
  return (
    <div className="bg-newBgColorInner flex-1 min-w-0 flex-col flex p-[20px] gap-[12px] overflow-y-auto">
      <LeadsComponent />
    </div>
  );
}
