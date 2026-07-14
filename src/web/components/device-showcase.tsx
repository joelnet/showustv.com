import { useState } from "react";

type DeviceKind = "iphone" | "galaxy";

const APP_SCREENSHOTS = {
  social: "/landing/social-graph.webp",
  comments: "/landing/comments.webp",
  watchHeader: "/landing/watch-now-header.webp",
  watchContent: "/landing/watch-now-content.webp",
  watchFooter: "/landing/watch-now-footer.webp",
};

export function detectDeviceKind(userAgent?: string): DeviceKind {
  const resolvedUserAgent = userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  return /iPhone|iPod/i.test(resolvedUserAgent) ? "iphone" : "galaxy";
}

function StatusChrome({
  device,
  time,
  battery,
}: {
  device: DeviceKind;
  time: string;
  battery: number;
}) {
  return (
    <div className={`device-status device-status--${device}`} aria-hidden="true">
      <span className="device-status-time">{device === "iphone" ? "9:41" : time}</span>
      <span className="device-status-icons">
        {device === "galaxy" && <span className="device-status-key" />}
        {device === "galaxy" && <span className="device-status-network">5G</span>}
        <span className="device-status-signal">
          <i />
          <i />
          <i />
          <i />
        </span>
        {device === "iphone" && <span className="device-status-wifi" />}
        <span className="device-status-battery">
          <i style={{ width: `${battery}%` }} />
        </span>
      </span>
    </div>
  );
}

function SystemNavigation({ device }: { device: DeviceKind }) {
  if (device === "iphone") {
    return (
      <div className="device-system-nav device-system-nav--iphone" aria-hidden="true">
        <i />
      </div>
    );
  }

  return (
    <div className="device-system-nav device-system-nav--galaxy" aria-hidden="true">
      <i className="device-recents" />
      <i className="device-home" />
      <i className="device-back" />
    </div>
  );
}

function DeviceFrame({
  device,
  position,
  label,
  time,
  battery,
  children,
}: {
  device: DeviceKind;
  position: "left" | "center" | "right";
  label: string;
  time: string;
  battery: number;
  children: React.ReactNode;
}) {
  return (
    <figure className={`showcase-device showcase-device--${position}`}>
      <div className={`device-frame device-frame--${device}`}>
        <span className="device-side-key device-side-key--one" aria-hidden="true" />
        <span className="device-side-key device-side-key--two" aria-hidden="true" />
        <div className="device-screen">
          <StatusChrome device={device} time={time} battery={battery} />
          <div className="device-app-screen">{children}</div>
          <SystemNavigation device={device} />
          <span className="device-camera" aria-hidden="true" />
        </div>
      </div>
      <figcaption className="sr-only">{label}</figcaption>
    </figure>
  );
}

function ScrollingWatchNow() {
  return (
    <div className="scrolling-shot">
      <img
        className="scrolling-shot-header"
        src={APP_SCREENSHOTS.watchHeader}
        width="720"
        height="115"
        alt=""
        decoding="async"
      />
      <div className="scrolling-shot-viewport">
        <img
          className="scrolling-shot-content"
          src={APP_SCREENSHOTS.watchContent}
          width="720"
          height="3681"
          alt=""
          loading="eager"
          fetchPriority="high"
          decoding="async"
        />
      </div>
      <img
        className="scrolling-shot-footer"
        src={APP_SCREENSHOTS.watchFooter}
        width="720"
        height="104"
        alt=""
        decoding="async"
      />
    </div>
  );
}

export function DeviceShowcase() {
  const [device] = useState<DeviceKind>(() => detectDeviceKind());

  return (
    <section
      className="device-showcase"
      data-device={device}
      aria-labelledby="device-showcase-title"
    >
      <h2 className="sr-only" id="device-showcase-title">
        See Show Us TV in action
      </h2>
      <div className="device-showcase-stage">
        <DeviceFrame
          device={device}
          position="left"
          label="A nested discussion on the Comments screen"
          time="12:47"
          battery={79}
        >
          <img
            className="device-static-shot"
            src={APP_SCREENSHOTS.comments}
            width="720"
            height="1416"
            alt=""
            loading="eager"
            decoding="async"
          />
        </DeviceFrame>

        <DeviceFrame
          device={device}
          position="center"
          label="The Watch Now screen scrolling through personalized sections while its header and navigation stay fixed"
          time="12:14"
          battery={85}
        >
          <ScrollingWatchNow />
        </DeviceFrame>

        <DeviceFrame
          device={device}
          position="right"
          label="The Socials screen showing a graph of shared viewing tastes"
          time="12:14"
          battery={84}
        >
          <img
            className="device-static-shot"
            src={APP_SCREENSHOTS.social}
            width="720"
            height="1416"
            alt=""
            loading="eager"
            decoding="async"
          />
        </DeviceFrame>
      </div>
    </section>
  );
}
