// App-wide icon set (Hugeicons). Components import icons from here, never from the icon library directly,
// so the whole look can be swapped in one place.
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  Add01Icon,
  Alert02Icon,
  FileImportIcon,
  AlarmClockIcon,
  Archive02Icon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowUp02Icon,
  DragDropVerticalIcon,
  LayoutLeftIcon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowTurnBackwardIcon,
  AtIcon,
  Attachment01Icon,
  Bookmark02Icon,
  BookmarkCheck02Icon,
  BubbleChatAddIcon,
  BubbleChatIcon,
  Call02Icon,
  CallEnd01Icon,
  Cancel01Icon,
  Chatting01Icon,
  CircleIcon,
  Clock01Icon,
  CodeSquareIcon,
  ComputerScreenShareIcon,
  Copy01Icon,
  Delete02Icon,
  Download04Icon,
  File01Icon,
  File02Icon,
  FileMusicIcon,
  FileScriptIcon,
  FileVideoIcon,
  FileZipIcon,
  Files01Icon,
  FolderTransferIcon,
  GlobeIcon,
  HashtagIcon,
  HeadphonesIcon,
  HelpCircleIcon,
  Home04Icon,
  Image01Icon,
  InboxIcon,
  InformationCircleIcon,
  Key01Icon,
  Layers01Icon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  Link01Icon,
  Link04Icon,
  LockIcon,
  Logout03Icon,
  Mail01Icon,
  Maximize01Icon,
  Megaphone01Icon,
  Message01Icon,
  Mic01Icon,
  MicOff01Icon,
  Minimize01Icon,
  Moon02Icon,
  MoreHorizontalIcon,
  MoreVerticalIcon,
  Notification03Icon,
  NotificationOff03Icon,
  PaintBoardIcon,
  PencilEdit01Icon,
  PencilEdit02Icon,
  PictureInPictureOnIcon,
  PinIcon,
  PlugSocketIcon,
  QuoteDownIcon,
  RoboticIcon,
  Search01Icon,
  SentIcon,
  Settings02Icon,
  Share01Icon,
  Share08Icon,
  SlashIcon,
  SmileIcon,
  SmilePlusIcon,
  SourceCodeIcon,
  StarIcon,
  StopIcon,
  Sun03Icon,
  TextBoldIcon,
  TextFontIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  Tick02Icon,
  TickDouble02Icon,
  Ticket01Icon,
  Upload04Icon,
  UserAdd01Icon,
  UserGroupIcon,
  UserIcon,
  UserRemove01Icon,
  Video01Icon,
  VideoOffIcon,
  VolumeHighIcon,
  WifiDisconnected01Icon,
  Xls01Icon,
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  LinkSquare02Icon,
} from '@hugeicons/core-free-icons';

export interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
  color?: string;
  fill?: string;
}

function make(icon: IconSvgElement, name: string) {
  const C = ({ size = 18, className, strokeWidth = 1.7, color = 'currentColor' }: IconProps) => (
    <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} color={color} className={className ? 'icon ' + className : 'icon'} />
  );
  C.displayName = name;
  return C;
}

export const AlarmClock = make(AlarmClockIcon, 'AlarmClock');
export const AlertTriangle = make(Alert02Icon, 'AlertTriangle');
export const FileImport = make(FileImportIcon, 'FileImport');
export const Archive = make(Archive02Icon, 'Archive');
export const ArrowDown = make(ArrowDown02Icon, 'ArrowDown');
export const ArrowUp = make(ArrowUp02Icon, 'ArrowUp');
export const GripVertical = make(DragDropVerticalIcon, 'GripVertical');
export const PanelLeft = make(LayoutLeftIcon, 'PanelLeft');
export const ArrowLeft = make(ArrowLeft02Icon, 'ArrowLeft');
export const ArrowRight = make(ArrowRight02Icon, 'ArrowRight');
export const AtSign = make(AtIcon, 'AtSign');
export const Bell = make(Notification03Icon, 'Bell');
export const BellOff = make(NotificationOff03Icon, 'BellOff');
export const Bold = make(TextBoldIcon, 'Bold');
export const Bookmark = make(Bookmark02Icon, 'Bookmark');
export const BookmarkCheck = make(BookmarkCheck02Icon, 'BookmarkCheck');
export const Bot = make(RoboticIcon, 'Bot');
export const Check = make(Tick02Icon, 'Check');
export const CheckCheck = make(TickDouble02Icon, 'CheckCheck');
export const ChevronDown = make(ArrowDown01Icon, 'ChevronDown');
export const ChevronLeft = make(ArrowLeft01Icon, 'ChevronLeft');
export const ChevronRight = make(ArrowRight01Icon, 'ChevronRight');
export const Circle = make(CircleIcon, 'Circle');
export const CircleHelp = make(HelpCircleIcon, 'CircleHelp');
export const Clock = make(Clock01Icon, 'Clock');
export const Code = make(SourceCodeIcon, 'Code');
export const Copy = make(Copy01Icon, 'Copy');
export const Download = make(Download04Icon, 'Download');
export const EllipsisVertical = make(MoreVerticalIcon, 'EllipsisVertical');
export const MoreHorizontal = make(MoreHorizontalIcon, 'MoreHorizontal');
export const File = make(File01Icon, 'File');
export const FileArchive = make(FileZipIcon, 'FileArchive');
export const FileAudio = make(FileMusicIcon, 'FileAudio');
export const FileCode = make(FileScriptIcon, 'FileCode');
export const FileSpreadsheet = make(Xls01Icon, 'FileSpreadsheet');
export const FileText = make(File02Icon, 'FileText');
export const FileVideo = make(FileVideoIcon, 'FileVideo');
export const Files = make(Files01Icon, 'Files');
export const FolderInput = make(FolderTransferIcon, 'FolderInput');
export const Forward = make(Share08Icon, 'Forward');
export const Globe = make(GlobeIcon, 'Globe');
export const Hash = make(HashtagIcon, 'Hash');
export const Headphones = make(HeadphonesIcon, 'Headphones');
export const Home = make(Home04Icon, 'Home');
export const Image = make(Image01Icon, 'Image');
export const Inbox = make(InboxIcon, 'Inbox');
export const Info = make(InformationCircleIcon, 'Info');
export const Italic = make(TextItalicIcon, 'Italic');
export const KeyRound = make(Key01Icon, 'KeyRound');
export const Layers = make(Layers01Icon, 'Layers');
export const Link = make(Link01Icon, 'Link');
export const Link2 = make(Link04Icon, 'Link2');
export const List = make(LeftToRightListBulletIcon, 'List');
export const ListOrdered = make(LeftToRightListNumberIcon, 'ListOrdered');
export const Lock = make(LockIcon, 'Lock');
export const LogOut = make(Logout03Icon, 'LogOut');
export const Mail = make(Mail01Icon, 'Mail');
export const Maximize2 = make(Maximize01Icon, 'Maximize2');
export const Megaphone = make(Megaphone01Icon, 'Megaphone');
export const MessageCircle = make(BubbleChatIcon, 'MessageCircle');
export const MessageSquare = make(Message01Icon, 'MessageSquare');
export const MessageSquareText = make(BubbleChatAddIcon, 'MessageSquareText');
export const MessagesSquare = make(Chatting01Icon, 'MessagesSquare');
export const Mic = make(Mic01Icon, 'Mic');
export const MicOff = make(MicOff01Icon, 'MicOff');
export const Minimize2 = make(Minimize01Icon, 'Minimize2');
export const MonitorUp = make(ComputerScreenShareIcon, 'MonitorUp');
export const Moon = make(Moon02Icon, 'Moon');
export const Palette = make(PaintBoardIcon, 'Palette');
export const Paperclip = make(Attachment01Icon, 'Paperclip');
export const Pencil = make(PencilEdit02Icon, 'Pencil');
export const Phone = make(Call02Icon, 'Phone');
export const PhoneOff = make(CallEnd01Icon, 'PhoneOff');
export const PictureInPicture2 = make(PictureInPictureOnIcon, 'PictureInPicture2');
export const Pin = make(PinIcon, 'Pin');
export const Plug = make(PlugSocketIcon, 'Plug');
export const Plus = make(Add01Icon, 'Plus');
export const RotateCcw = make(ArrowTurnBackwardIcon, 'RotateCcw');
export const Search = make(Search01Icon, 'Search');
export const Send = make(SentIcon, 'Send');
export const SendHorizontal = make(SentIcon, 'SendHorizontal');
export const Settings = make(Settings02Icon, 'Settings');
export const Share2 = make(Share01Icon, 'Share2');
export const Smile = make(SmileIcon, 'Smile');
export const SmilePlus = make(SmilePlusIcon, 'SmilePlus');
export const Square = make(StopIcon, 'Square');
export const SquareCode = make(CodeSquareIcon, 'SquareCode');
export const SquarePen = make(PencilEdit01Icon, 'SquarePen');
export const SquareSlash = make(SlashIcon, 'SquareSlash');
export const Star = make(StarIcon, 'Star');
export const Strikethrough = make(TextStrikethroughIcon, 'Strikethrough');
export const Sun = make(Sun03Icon, 'Sun');
export const TextQuote = make(QuoteDownIcon, 'TextQuote');
export const Ticket = make(Ticket01Icon, 'Ticket');
export const Trash2 = make(Delete02Icon, 'Trash2');
export const Type = make(TextFontIcon, 'Type');
export const Unplug = make(PlugSocketIcon, 'Unplug');
export const Upload = make(Upload04Icon, 'Upload');
export const User = make(UserIcon, 'User');
export const UserMinus = make(UserRemove01Icon, 'UserMinus');
export const UserPlus = make(UserAdd01Icon, 'UserPlus');
export const Users = make(UserGroupIcon, 'Users');
export const Video = make(Video01Icon, 'Video');
export const VideoOff = make(VideoOffIcon, 'VideoOff');
export const Volume2 = make(VolumeHighIcon, 'Volume2');
export const WifiOff = make(WifiDisconnected01Icon, 'WifiOff');
export const X = make(Cancel01Icon, 'X');
export const CircleAlert = make(AlertCircleIcon, 'CircleAlert');
export const CircleCheck = make(CheckmarkCircle02Icon, 'CircleCheck');
export const ExternalLink = make(LinkSquare02Icon, 'ExternalLink');
