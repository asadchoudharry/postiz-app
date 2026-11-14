'use client';

import { FC } from 'react';
import { useParams } from 'next/navigation';
import { SubmissionDetailComponent } from '@gitroom/frontend/components/rektrs/submission.detail.component';

export const ReviewSubmissionDetailPage: FC = () => {
  const params = useParams<{ id: string }>();
  return <SubmissionDetailComponent submissionId={params.id} mode="review" />;
};

export const MySubmissionDetailPage: FC = () => {
  const params = useParams<{ id: string }>();
  return <SubmissionDetailComponent submissionId={params.id} mode="mine" />;
};
