import { SmpteBars, Wordmark } from "../components/ui";

export function AboutPage() {
  return (
    <div className="about">
      <Wordmark />
      <SmpteBars />
      <p>
        A personal tracker for shows and movies: follow what you watch, keep your place with the Up
        Next queue, and never miss an air date. Built as a home for TV Time refugees.
      </p>
      <h2 className="section-title">Data</h2>
      <p>
        This product uses the{" "}
        <a href="https://www.themoviedb.org" rel="noreferrer">
          <span className="tmdb-mark">TMDB</span>
        </a>{" "}
        API but is not endorsed or certified by TMDB. All show and movie metadata and imagery come
        from <a href="https://www.themoviedb.org" rel="noreferrer">The Movie Database</a>.
      </p>
      <p>
        Where-to-watch listings are streaming data by{" "}
        <a href="https://www.justwatch.com" rel="noreferrer">JustWatch</a>.
      </p>
    </div>
  );
}
