import { CageStage } from "@/components/cage-stage";
import { site } from "@/lib/site";

/**
 * The answer to "an abliterated model, with access to my code?", shown right
 * after the pitch that introduces the models. Every line here has to stay true
 * of the hosted service; docs/security.mdx is the long version. The sandbox
 * above the list shows the same thing: the model throws sand as hard as it
 * likes, and none of it gets out of the box.
 */
export function Safety() {
  return (
    <section className="section" aria-labelledby="safety-title">
      <h2 id="safety-title" className="section-title">
        Unrestricted, not unleashed
      </h2>
      <p className="pitch-body">
        Abliterated means the model won&rsquo;t refuse. It doesn&rsquo;t get any more access. Here is all it gets:
      </p>
      <CageStage />
      <ul className="pitch-list safety-list">
        <li>Read-only access to the repositories you pick. It never pushes code or opens issues.</li>
        <li>Its own virtual machine for each scan, deleted the moment the scan ends</li>
        <li>No shell and no network. It never runs your code or the exploits it writes.</li>
        <li>Nothing kept: your code isn&rsquo;t stored, only the findings and the few lines that explain them</li>
      </ul>
      <p className="strip-caption safety-more">
        <a href={site.links.security}>How your code is handled</a>, or <a href={site.githubUrl}>read the source</a> and
        host it yourself.
      </p>
    </section>
  );
}
