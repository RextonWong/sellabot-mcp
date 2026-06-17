/**
 * Minimal raw Shopee response shapes. Only the fields the mappers read are
 * declared; everything is optional/defensive because the live API evolves.
 */

export interface RawPriceInfo {
  current_price?: number;
  original_price?: number;
}

export interface RawStockSummary {
  total_available_stock?: number;
}

export interface RawModel {
  model_id?: number;
  model_name?: string;
  price_info?: RawPriceInfo[];
  stock_info_v2?: { summary_info?: RawStockSummary };
  tier_index?: number[];
}

export interface RawItem {
  item_id?: number;
  item_name?: string;
  description?: string;
  item_status?: string;
  item_sku?: string;
  category_id?: number;
  image?: { image_url_list?: string[] };
  price_info?: RawPriceInfo[];
  stock_info_v2?: { summary_info?: RawStockSummary };
  has_model?: boolean;
}

export interface RawOrderItem {
  item_id?: number;
  model_id?: number;
  item_name?: string;
  model_quantity_purchased?: number;
  model_discounted_price?: number;
}

export interface RawRecipientAddress {
  name?: string;
  phone?: string;
  full_address?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  region?: string;
}

export interface RawOrder {
  order_sn?: string;
  order_status?: string;
  total_amount?: number;
  currency?: string;
  buyer_username?: string;
  create_time?: number;
  ship_by_date?: number;
  tracking_number?: string;
  recipient_address?: RawRecipientAddress;
  item_list?: RawOrderItem[];
}

export interface RawReturn {
  return_sn?: string;
  order_sn?: string;
  status?: string;
  reason?: string;
  refund_amount?: number;
  currency?: string;
  user?: { username?: string };
  image?: string[];
  create_time?: number;
}

export interface RawVoucher {
  voucher_id?: number;
  voucher_name?: string;
  voucher_type?: number;
  discount_amount?: number;
  percentage?: number;
  max_price?: number;
  min_basket_price?: number;
  usage_quantity?: number;
  start_time?: number;
  end_time?: number;
  voucher_purpose?: number;
  item_id_list?: number[];
}

export interface RawConversation {
  conversation_id?: string;
  to_name?: string;
  latest_message_content?: { text?: string };
  unread_count?: number;
  last_message_timestamp?: number;
}

export interface RawComment {
  comment_id?: number;
  item_id?: number;
  rating_star?: number;
  comment?: string;
  buyer_username?: string;
  comment_reply?: { reply?: string } | null;
  create_time?: number;
}
