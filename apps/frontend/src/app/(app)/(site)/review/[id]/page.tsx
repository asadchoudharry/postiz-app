export const dynamic = 'force-dynamic';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { ReviewSubmissionDetailPage } from '@gitroom/frontend/components/rektrs/submission.detail.page';

const brandOn = process.env.NEXT_PUBLIC_REKTRS_SOCIAL_BRAND === 'true';

export const metadata: Metadata = {
  title: `${brandOn ? 'REKTRS Social' : 'Postiz'} Review Submission`,
  description: '',
};

export default async function Page() {
  if (!brandOn) {
    notFound();
  }
  return (
    <div className="bg-newBgColorInner flex-1 min-w-0 flex-col flex p-[20px] gap-[12px] overflow-y-auto">
      <ReviewSubmissionDetailPage />
    </div>
  );
}
