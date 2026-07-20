/**
 * Shopee API v2 path constants. Hosts are environment-dependent (see config).
 * Paths are the `/api/v2/...` portion used both in the URL and the signature
 * base string.
 */
export const PATHS = {
  // auth (public)
  authShopAuthPartner: "/api/v2/shop/auth_partner", // browser authorization page (the link the seller opens)
  authTokenGet: "/api/v2/auth/token/get", // exchange the auth code -> access + refresh tokens
  authAccessTokenGet: "/api/v2/auth/access_token/get", // refresh an expired access token

  // shop
  shopGetInfo: "/api/v2/shop/get_shop_info",
  shopGetProfile: "/api/v2/shop/get_profile",
  shopPerformance: "/api/v2/account_health/shop_performance",

  // product
  productGetItemList: "/api/v2/product/get_item_list",
  productGetItemBaseInfo: "/api/v2/product/get_item_base_info",
  productGetModelList: "/api/v2/product/get_model_list",
  productAddItem: "/api/v2/product/add_item",
  productUpdateItem: "/api/v2/product/update_item",
  productDeleteItem: "/api/v2/product/delete_item",
  productUnlistItem: "/api/v2/product/unlist_item",
  productUpdatePrice: "/api/v2/product/update_price",
  productUpdateStock: "/api/v2/product/update_stock",
  productBoostItem: "/api/v2/product/boost_item",

  // order
  orderGetList: "/api/v2/order/get_order_list",
  orderGetDetail: "/api/v2/order/get_order_detail",
  orderCancel: "/api/v2/order/cancel_order",
  orderHandleBuyerCancellation: "/api/v2/order/handle_buyer_cancellation",

  // logistics
  logisticsGetShippingParameter: "/api/v2/logistics/get_shipping_parameter",
  logisticsShipOrder: "/api/v2/logistics/ship_order",
  logisticsGetTrackingInfo: "/api/v2/logistics/get_tracking_info",
  logisticsCreateShippingDocument: "/api/v2/logistics/create_shipping_document",
  logisticsDownloadShippingDocument: "/api/v2/logistics/download_shipping_document",

  // returns
  returnsGetList: "/api/v2/returns/get_return_list",
  returnsGetDetail: "/api/v2/returns/get_return_detail",
  returnsConfirm: "/api/v2/returns/confirm",
  returnsDispute: "/api/v2/returns/dispute",

  // chat
  chatGetConversationList: "/api/v2/sellerchat/get_conversation_list",
  chatSendMessage: "/api/v2/sellerchat/send_message",

  // reviews / comments
  commentGetList: "/api/v2/product/get_comment",
  commentReply: "/api/v2/product/reply_comment",

  // vouchers
  voucherGetList: "/api/v2/voucher/get_voucher_list",
  voucherAdd: "/api/v2/voucher/add_voucher",

  // product image upload (multipart POST, field name: "image")
  productUploadImage: "/api/v2/product/upload_image",

  // category tree
  productGetCategory: "/api/v2/product/get_category",

  // logistics channels (needed when creating a new listing)
  logisticsGetChannelList: "/api/v2/logistics/get_channel_list",
} as const;

export type ApiPath = (typeof PATHS)[keyof typeof PATHS];
