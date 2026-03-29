"use client";

type EmptyStateCardProps = {
  title: string;
  description: string;
};

export default function EmptyStateCard({ title, description }: EmptyStateCardProps) {
  return (
    <div className="empty-card">
      <div className="empty-ill" aria-hidden>
        <div className="empty-truck">
          <span className="empty-truck-cabin" />
          <span className="empty-truck-body" />
          <span className="empty-truck-wheel empty-truck-wheel-left" />
          <span className="empty-truck-wheel empty-truck-wheel-right" />
        </div>
        <div className="empty-route" />
        <div className="empty-line short" />
        <div className="empty-line" />
      </div>
      <div className="empty-title">{title}</div>
      <div className="empty-desc">{description}</div>
    </div>
  );
}
