// Icon set — Lucide (https://lucide.dev), stroke-based SVG components imported
// individually so the bundle only ships the glyphs in use (issue #314). Each
// IconX keeps its former export name and `{ size }` prop, so the ~30 call
// sites are unchanged; only the underlying glyph (and the lighter stroke look)
// swapped over from Font Awesome. Brand marks below stay hand-inlined — Lucide
// is a UI-icon set, not a logo set.
import {
  Play,
  Search,
  LayoutGrid,
  List,
  Settings,
  Check,
  Plus,
  ChevronRight,
  ChevronLeft,
  Trash2,
  Bookmark,
  Heart,
  Eye,
  EyeOff,
  ArrowUp,
  ArrowDown,
  CalendarDays,
  Clock,
  Film,
  Tv,
  Star,
  User,
  Users,
  TriangleAlert,
  Download,
  ExternalLink,
  MessageCircle,
  X,
  Bell,
  Share2,
  Lock,
  Pencil,
  Handshake,
  HatGlasses,
  type LucideIcon,
} from "lucide-react";

// The old Font Awesome wrapper defaulted glyphs to 17px; keep that so nothing
// shifts. `fill` lets the two states of the favorites toggle share one glyph:
// filled when favorited (IconHeart), outline otherwise (IconHeartOutline).
const DEFAULT_SIZE = 17;
const STROKE_WIDTH = 2;

const make =
  (Icon: LucideIcon, fill: string = "none") =>
  ({ size = DEFAULT_SIZE }: { size?: number }) => (
    <Icon size={size} strokeWidth={STROKE_WIDTH} fill={fill} aria-hidden="true" />
  );

export const IconPlay = make(Play);
export const IconSearch = make(Search);
export const IconLibrary = make(LayoutGrid);
export const IconList = make(List);
export const IconGear = make(Settings);
export const IconCheck = make(Check);
export const IconPlus = make(Plus);
export const IconChevron = make(ChevronRight);
export const IconChevronLeft = make(ChevronLeft);
export const IconTrash = make(Trash2);
export const IconBookmark = make(Bookmark);
export const IconHeart = make(Heart, "currentColor"); // filled — favorited / favorites lists
export const IconHeartOutline = make(Heart); // outline — not favorited
export const IconEye = make(Eye);
export const IconEyeSlash = make(EyeOff);
export const IconArrowUp = make(ArrowUp);
export const IconArrowDown = make(ArrowDown);
export const IconCalendar = make(CalendarDays);
export const IconClock = make(Clock);
export const IconFilm = make(Film);
export const IconTv = make(Tv);
export const IconStar = make(Star);
export const IconUser = make(User);
export const IconUsers = make(Users);
export const IconWarning = make(TriangleAlert);
export const IconDownload = make(Download);
export const IconExternal = make(ExternalLink);
export const IconComment = make(MessageCircle);
export const IconClose = make(X);
export const IconBell = make(Bell);
export const IconShare = make(Share2);
export const IconLock = make(Lock);
export const IconPencil = make(Pencil);
export const IconHandshake = make(Handshake);
// Per-show hide toggle (issue #260, #314) — the "incognito" hat-and-glasses
// glyph, matching the privacy affordance's disguise metaphor.
export const IconHatGlasses = make(HatGlasses);

// Brand glyphs — Lucide is a UI-icon set, not a logo set, so these stay
// hand-inlined SVG. `currentColor` lets links style them like text.
export const IconX = ({ size = 17 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);
export const IconDiscord = ({ size = 17 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.955 2.419-2.157 2.419zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.946 2.419-2.157 2.419z" />
  </svg>
);

// IMDb & Rotten Tomatoes brand marks for the detail pages' "Elsewhere"
// off-site links (issue #292). Bundled as inline SVG — Lucide carries no brand
// logos — and drawn in each brand's own colour so they read as logos alongside
// the streaming-provider logos. Glyph paths from Simple Icons.
export const IconImdb = ({ size = 30 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="#F5C518" aria-hidden="true">
    <path d="M22.3781 0H1.6218C.7411.0583.0587.7437.0018 1.5953l-.001 20.783c.0585.8761.7125 1.543 1.5559 1.6191A.337.337 0 0 0 1.6016 24h20.7971a.4579.4579 0 0 0 .0437-.002c.8727-.0768 1.5568-.8271 1.5568-1.7085V1.7098c0-.8914-.696-1.6416-1.584-1.7078A.3294.3294 0 0 0 22.3781 0zm0 .496a1.2144 1.2144 0 0 1 1.1252 1.2139v20.5797c0 .6377-.4875 1.1602-1.1045 1.2145H1.6016c-.5967-.0543-1.0645-.5297-1.1053-1.1258V1.6284C.5371 1.0185 1.0184.5364 1.6217.496h20.7564zM4.7954 8.2603v7.3636H2.8899V8.2603h1.9055zm6.5367 0v7.3636H9.6707v-4.9704l-.6711 4.9704H7.813l-.6986-4.8618-.0066 4.8618h-1.668V8.2603h2.468c.0748.4476.1492.9694.2307 1.5734l.2712 1.8713.4407-3.4447h2.4817zm2.9772 1.3289c.0742.0404.122.108.1417.2034.0279.0953.0345.3118.0345.6442v2.8548c0 .4881-.0345.7867-.0955.8954-.0609.1152-.2304.1695-.5018.1695V9.5211c.204 0 .3457.0205.4211.0681zm-.0211 6.0347c.4543 0 .8006-.0265 1.0245-.0742.2304-.0477.4204-.1357.5694-.2648.1556-.1218.2642-.298.3251-.5219.0611-.2238.1021-.6648.1021-1.3224v-2.5832c0-.6986-.0271-1.1668-.0742-1.4039-.041-.237-.1431-.4543-.3126-.6437-.1695-.1973-.4198-.3324-.7456-.421-.3191-.0808-.8542-.1285-1.7694-.1285h-1.4244v7.3636h2.3051zm5.14-1.7827c0 .3523-.0199.5762-.0544.6708-.033.0947-.1894.1424-.3046.1424-.1086 0-.19-.0477-.2238-.1351-.041-.0887-.0609-.2986-.0609-.6238v-1.9469c0-.3324.0199-.5423.0543-.6237.0338-.0808.1086-.122.2171-.122.1153 0 .2709.0412.3114.1425.041.0947.0609.2986.0609.6032v1.8926zm-2.4747-5.5809v7.3636h1.7157l.1152-.4675c.1556.1894.3251.3324.5152.4271.1828.0881.4608.1357.678.1357.3047 0 .5629-.0748.7802-.237.2165-.1562.3589-.3462.4198-.5628.0543-.2173.0887-.543.0887-.9841v-2.0675c0-.4409-.0139-.7324-.0344-.8681-.0199-.1357-.0742-.2781-.1695-.4204-.1021-.1425-.2437-.251-.4272-.3325-.1834-.0742-.3999-.1152-.6576-.1152-.2172 0-.4952.0477-.6846.1285-.1835.0887-.353.2238-.5086.4007V8.2603h-1.8309z" />
  </svg>
);
export const IconRottenTomatoes = ({ size = 30 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="#FA320A" aria-hidden="true">
    <path d="M5.866 0L4.335 1.262l2.082 1.8c-2.629-.989-4.842 1.4-5.012 2.338 1.384-.323 2.24-.422 3.344-.335-7.042 4.634-4.978 13.148-1.434 16.094 5.784 4.612 13.77 3.202 17.91-1.316C27.26 13.363 22.993.65 10.86 2.766c.107-1.17.633-1.503 1.243-1.602-.89-1.493-3.67-.734-4.556 1.374C7.52 2.602 5.866 0 5.866 0zM4.422 7.217H6.9c2.673 0 2.898.012 3.55.202 1.06.307 1.868.973 2.313 1.904.05.106.092.206.13.305l7.623.008.027 2.912-2.745-.024v7.549l-2.982-.016v-7.522l-2.127.016a2.92 2.92 0 0 1-1.056 1.134c-.287.176-.3.19-.254.264.127.2 2.125 3.642 2.125 3.659l-3.39.019-2.013-3.376c-.034-.047-.122-.068-.344-.084l-.297-.02.037 3.48-3.075-.038zm3.016 2.288l.024.338c.014.186.024.729.024 1.206v.867l.582-.025c.32-.013.695-.049.833-.078.694-.146 1.048-.478 1.087-1.018.027-.378-.063-.636-.303-.87-.318-.309-.761-.416-1.733-.418Z" />
  </svg>
);
