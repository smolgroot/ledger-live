import { getElementById, typeTextByElement } from "e2e/helpers";

export default class Common {
  searchBarId = "common-search-field";
  searchBar = () => getElementById(this.searchBarId);

  async performSearch(text: string) {
    return typeTextByElement(this.searchBar(), text);
  }
}
