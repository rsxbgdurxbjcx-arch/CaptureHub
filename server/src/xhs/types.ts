export type LiveStatus = 'success' | 'offline' | string;

export interface RoomInfo {
  roomTitle: string;
  roomId: string;
  roomCover?: string;
  deeplink?: string;
  [key: string]: unknown;
}

export interface HostInfo {
  nickName: string;
  avatar: string;
  [key: string]: unknown;
}

export interface LiveStreamData {
  liveStatus?: LiveStatus;
  roomData?: {
    roomInfo: RoomInfo;
    hostInfo: HostInfo;
  };
  [key: string]: unknown;
}

export interface InitialState {
  liveStream?: LiveStreamData;
  user?: {
    userPageData?: {
      basicInfo?: {
        redId?: string;
        nickname?: string;
        images?: string;
      };
    };
  };
  [key: string]: unknown;
}

export interface LiveInfoResponse {
  anchor_name?: string;
  is_live: boolean;
  title?: string;
  flv_url?: string;
  m3u8_url?: string;
  avatar?: string;
  cover?: string;
  room_id?: string;
}

export interface UserSearchLiveInfo {
  living: boolean;
  roomId: string | null;
  owner: string;
  avatar: string;
  liveStartTime: Date | null;
}
