// 範本試算表綁定的薄殼（PLAN 4.7、4.8、6.2）：選單、側邊欄、自動跳轉。不部署成 Web App。

export function onOpen(): void {
  SpreadsheetApp.getUi().createMenu("報到").addItem("顯示報到側邊欄", "showSidebar").addToUi();
}

export function showSidebar(): void {
  const html = HtmlService.createHtmlOutput("<p>尚未實作</p>").setTitle("報到");
  SpreadsheetApp.getUi().showSidebar(html);
}
